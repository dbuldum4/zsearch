// zsearch-embed: embedding vectors for zsearch's semantic search, on llama.cpp: IBM's Granite embedding
// model (granite-embedding-small-english-r2, ModernBERT) for text.
//
// Adapted from DigUp (https://github.com/ARahim3/DigUp): LlamaEmbedder.swift (how inputs are framed, pooled
// and normalized). Copyright (c) 2026 Abdur Rahim, MIT License; see THIRD_PARTY_NOTICES.md.
//
// What is different from DigUp's runtime, for speed: every request is a group of inputs from many files,
// sorted by length and packed into as few llama.cpp calls as fit (DigUp runs one file at a time, up to 16
// inputs per call).
//
// Protocol, on stdin and stdout: every message is a little-endian u32 byte count and that many bytes.
//   request  'i'                                   -> status 0, JSON with the model's facts
//   request  't' u32 n, n x (u32 len, utf-8)       -> status 0, u32 n, u32 dim, u32 tokens, n x dim f32
//   request  'q'                                   -> exits
// A failed request answers status 1, u32 len, message. Logs go to stderr only.

#include "llama.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

// Which vectors this helper makes. Bump it with anything that changes them (llama.cpp tag, framing,
// pooling): zsearch then embeds everything again rather than mix incomparable vectors.
static const int VECTOR_VERSION = 2;   // 2: pooling as the model says (Granite: its CLS token)

struct Options {
    std::string model;
    int threads = 0;
    int batch_tokens = 2048;   // tokens per llama.cpp call (one micro-batch: the model is non-causal)
    int max_seqs = 64;         // inputs per call
    int max_input = 2048;      // tokens kept of one input (the reference's cut)
    bool sort = true;          // pack inputs of similar length together
    int flash_attn = -1;       // -1 auto, 0 off, 1 on
    enum llama_pooling_type pooling = LLAMA_POOLING_TYPE_UNSPECIFIED;   // the model's own, unless given
};

static int log_level_min = GGML_LOG_LEVEL_WARN;
static int log_level_last = GGML_LOG_LEVEL_INFO;

static void log_callback(ggml_log_level level, const char * text, void *) {
    if (level != GGML_LOG_LEVEL_CONT) log_level_last = level;
    if (log_level_last >= log_level_min && text) fputs(text, stderr);
}

// ------------------------------------------------------------------------------------------------- io --

static bool read_exact(void * dst, size_t n) {
    return n == 0 || fread(dst, 1, n, stdin) == n;
}

struct Reader {
    const uint8_t * p;
    const uint8_t * end;
    uint32_t u32() {
        if (end - p < 4) throw std::runtime_error("short message");
        uint32_t v = (uint32_t) p[0] | ((uint32_t) p[1] << 8) | ((uint32_t) p[2] << 16) | ((uint32_t) p[3] << 24);
        p += 4;
        return v;
    }
    std::string str() {
        uint32_t n = u32();
        if ((size_t) (end - p) < n) throw std::runtime_error("short message");
        std::string s((const char *) p, n);
        p += n;
        return s;
    }
};

struct Writer {
    std::vector<uint8_t> out;
    void u8(uint8_t v) { out.push_back(v); }
    void u32(uint32_t v) {
        for (int i = 0; i < 4; i++) out.push_back((uint8_t) (v >> (8 * i)));
    }
    void bytes(const void * data, size_t n) {
        const uint8_t * b = (const uint8_t *) data;
        out.insert(out.end(), b, b + n);
    }
    void str(const std::string & s) {
        u32((uint32_t) s.size());
        bytes(s.data(), s.size());
    }
    void floats(const float * v, size_t n) { bytes(v, n * sizeof(float)); }   // little-endian hosts only
    void send() {
        uint8_t len[4];
        for (int i = 0; i < 4; i++) len[i] = (uint8_t) (out.size() >> (8 * i));
        fwrite(len, 1, 4, stdout);
        fwrite(out.data(), 1, out.size(), stdout);
        fflush(stdout);
    }
};

static void send_error(const std::string & message) {
    Writer w;
    w.u8(1);
    w.str(message);
    w.send();
}

// ------------------------------------------------------------------------------------------ embedder --

class Embedder {
  public:
    explicit Embedder(const Options & o) : opt(o) {
        llama_log_set(log_callback, nullptr);
        llama_backend_init();
        llama_model_params mp = llama_model_default_params();
        mp.n_gpu_layers = 999;
        model = llama_model_load_from_file(opt.model.c_str(), mp);
        if (!model) throw std::runtime_error("can't load " + opt.model);
        vocab = llama_model_get_vocab(model);
        dim = llama_model_n_embd_out(model);
        opt.max_input = std::min(opt.max_input, opt.batch_tokens);

        llama_context_params cp = llama_context_default_params();
        cp.n_ctx = (uint32_t) opt.batch_tokens;
        cp.n_batch = (uint32_t) opt.batch_tokens;
        cp.n_ubatch = (uint32_t) opt.batch_tokens;
        cp.n_seq_max = (uint32_t) opt.max_seqs;
        cp.kv_unified = true;   // each input may use the whole context, as in llama-embedding
        cp.embeddings = true;
        cp.pooling_type = opt.pooling;
        cp.flash_attn_type = opt.flash_attn < 0 ? LLAMA_FLASH_ATTN_TYPE_AUTO
                             : opt.flash_attn ? LLAMA_FLASH_ATTN_TYPE_ENABLED : LLAMA_FLASH_ATTN_TYPE_DISABLED;
        int threads = opt.threads > 0 ? opt.threads : (int) std::max(1u, std::thread::hardware_concurrency());
        cp.n_threads = threads;
        cp.n_threads_batch = threads;
        ctx = llama_init_from_model(model, cp);
        if (!ctx) throw std::runtime_error("can't create a llama.cpp context");
        batch = llama_batch_ext_init(ctx);
    }

    ~Embedder() {
        if (batch) llama_batch_ext_free(batch);
        if (ctx) llama_free(ctx);
        if (model) llama_model_free(model);
    }

    int dimension() const { return dim; }
    const Options & options() const { return opt; }

    // The text with the model's special tokens (`<bos> text <eos>`, `[CLS] text [SEP]`), cut the way
    // transformers cuts (keeping both).
    std::vector<llama_token> tokenize(const std::string & text) const {
        std::vector<llama_token> tokens(text.size() + 8);
        int n = llama_tokenize(vocab, text.data(), (int32_t) text.size(), tokens.data(), (int32_t) tokens.size(), true, true);
        if (n < 0) {
            tokens.resize((size_t) -n);
            n = llama_tokenize(vocab, text.data(), (int32_t) text.size(), tokens.data(), (int32_t) tokens.size(), true, true);
        }
        tokens.resize((size_t) std::max(n, 0));
        if ((int) tokens.size() > opt.max_input) {
            llama_token last = tokens.back();
            tokens.resize((size_t) opt.max_input - 1);
            tokens.push_back(last);
        }
        return tokens;
    }

    // One vector per text, in order, `dim` floats each. Inputs are packed by length into as few calls as fit.
    std::vector<float> embed_texts(const std::vector<std::string> & texts, uint32_t & token_count) {
        std::vector<std::vector<llama_token>> tokens(texts.size());
        token_count = 0;
        for (size_t i = 0; i < texts.size(); i++) {
            tokens[i] = tokenize(texts[i]);
            token_count += (uint32_t) tokens[i].size();
        }
        std::vector<size_t> order(texts.size());
        for (size_t i = 0; i < order.size(); i++) order[i] = i;
        if (opt.sort) {
            std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) { return tokens[a].size() > tokens[b].size(); });
        }
        std::vector<float> out(texts.size() * (size_t) dim, 0.0f);
        std::vector<size_t> members;
        int used = 0;
        auto flush = [&]() {
            if (members.empty()) return;
            run(members, out);
            members.clear();
            used = 0;
        };
        reset();
        for (size_t idx : order) {
            const auto & t = tokens[idx];
            if (!members.empty() && ((int) members.size() == opt.max_seqs || used + (int) t.size() > opt.batch_tokens)) flush();
            begin();
            for (llama_token tok : t) add_token(tok);
            members.push_back(idx);
            used += (int) t.size();
        }
        flush();
        return out;
    }

  private:
    Options opt;
    llama_model * model = nullptr;
    llama_context * ctx = nullptr;
    llama_batch_ext * batch = nullptr;
    const llama_vocab * vocab = nullptr;
    int dim = 0;
    int sequences = 0;
    llama_pos position = 0;

    void reset() {
        llama_batch_ext_clear(batch);
        sequences = 0;
    }

    void begin() {
        sequences++;
        position = 0;
    }

    void place(int32_t index) {
        if (index < 0) throw std::runtime_error("batch full (" + std::to_string(index) + ")");
        llama_pos pos[4] = {position, 0, 0, 0};
        if (!llama_batch_ext_set_pos(batch, index, pos) || !llama_batch_ext_set_output_embd(batch, index, true)) {
            throw std::runtime_error("can't place token " + std::to_string(index));
        }
        position++;
    }

    void add_token(llama_token t) { place(llama_batch_ext_add_token(batch, sequences - 1, t)); }

    // Runs the batch; writes each sequence's pooled, L2-normalized vector to out[members[seq]].
    void run(const std::vector<size_t> & members, std::vector<float> & out) {
        int status = llama_process(ctx, LLAMA_PROCESS_TYPE_ENCODE, batch);
        int n = sequences;
        reset();
        if (status != 0) throw std::runtime_error("llama_process failed (" + std::to_string(status) + ")");
        for (int s = 0; s < n; s++) {
            const float * pooled = llama_get_embeddings_seq(ctx, s);
            if (!pooled) throw std::runtime_error("no pooled embedding for input " + std::to_string(s));
            double sum = 0;
            for (int i = 0; i < dim; i++) sum += (double) pooled[i] * pooled[i];
            float scale = sum > 0 ? (float) (1.0 / std::sqrt(sum)) : 0.0f;
            float * dst = out.data() + members[(size_t) s] * (size_t) dim;
            for (int i = 0; i < dim; i++) dst[i] = pooled[i] * scale;
        }
    }
};

// -------------------------------------------------------------------------------------------- main --

static void usage() {
    fprintf(stderr,
            "usage: zsearch-embed --model TEXT.gguf [--threads N] [--batch-tokens N]\n"
            "                     [--max-seqs N] [--max-input N] [--no-sort] [--flash-attn auto|on|off]\n"
            "                     [--pooling mean|cls]\n"
            "Reads requests on stdin and writes vectors on stdout (see the top of zsearch-embed.cpp).\n");
}

int main(int argc, char ** argv) {
    Options opt;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        auto next = [&]() -> std::string {
            if (i + 1 >= argc) { usage(); exit(2); }
            return argv[++i];
        };
        if (a == "--model") opt.model = next();
        else if (a == "--threads") opt.threads = atoi(next().c_str());
        else if (a == "--batch-tokens") opt.batch_tokens = std::max(64, atoi(next().c_str()));
        else if (a == "--max-seqs") opt.max_seqs = std::max(1, atoi(next().c_str()));
        else if (a == "--max-input") opt.max_input = std::max(8, atoi(next().c_str()));
        else if (a == "--no-sort") opt.sort = false;
        else if (a == "--flash-attn") { std::string v = next(); opt.flash_attn = v == "on" ? 1 : v == "off" ? 0 : -1; }
        else if (a == "--pooling") {
            std::string v = next();
            if (v == "mean") opt.pooling = LLAMA_POOLING_TYPE_MEAN;
            else if (v == "cls") opt.pooling = LLAMA_POOLING_TYPE_CLS;
            else { usage(); return 2; }
        }
        else if (a == "--verbose") log_level_min = GGML_LOG_LEVEL_INFO;
        else if (a == "--version") { printf("zsearch-embed vectors %d\n", VECTOR_VERSION); return 0; }
        else { usage(); return 2; }
    }
    if (opt.model.empty()) { usage(); return 2; }

    Embedder * embedder;
    try {
        embedder = new Embedder(opt);
    } catch (const std::exception & e) {
        fprintf(stderr, "zsearch-embed: %s\n", e.what());
        return 1;
    }

    std::vector<uint8_t> msg;
    for (;;) {
        uint8_t len[4];
        if (!read_exact(len, 4)) break;
        uint32_t n = (uint32_t) len[0] | ((uint32_t) len[1] << 8) | ((uint32_t) len[2] << 16) | ((uint32_t) len[3] << 24);
        if (n == 0 || n > (1u << 30)) break;
        msg.resize(n);
        if (!read_exact(msg.data(), n)) break;
        uint8_t op = msg[0];
        Reader r{msg.data() + 1, msg.data() + n};
        try {
            if (op == 'q') break;
            if (op == 'i') {
                const Options & o = embedder->options();
                char json[512];
                snprintf(json, sizeof json,
                         "{\"dim\":%d,\"vectorVersion\":%d,\"batchTokens\":%d,\"maxSeqs\":%d,\"maxInput\":%d}",
                         embedder->dimension(), VECTOR_VERSION, o.batch_tokens,
                         o.max_seqs, o.max_input);
                Writer w;
                w.u8(0);
                w.str(json);
                w.send();
            } else if (op == 't') {
                uint32_t count = r.u32();
                std::vector<std::string> texts;
                texts.reserve(count);
                for (uint32_t i = 0; i < count; i++) texts.push_back(r.str());
                uint32_t tokens = 0;
                std::vector<float> vectors = embedder->embed_texts(texts, tokens);
                Writer w;
                w.u8(0);
                w.u32(count);
                w.u32((uint32_t) embedder->dimension());
                w.u32(tokens);
                w.floats(vectors.data(), vectors.size());
                w.send();
            } else {
                throw std::runtime_error("unknown request");
            }
        } catch (const std::exception & e) {
            send_error(e.what());
        }
    }
    delete embedder;
    return 0;
}
