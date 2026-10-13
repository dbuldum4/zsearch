// zsearch-embed: embedding vectors for zsearch's semantic search, on llama.cpp: IBM's Granite embedding
// model (granite-embedding-small-english-r2, ModernBERT) for text. It was written for EmbeddingGemma 2, whose
// image encoder (--mmproj) it can still run.
//
// Adapted from DigUp (https://github.com/ARahim3/DigUp): LlamaEmbedder.swift (how inputs are framed, pooled
// and normalized, and how image rows feed the text model) and ImageSizing.swift (the reference's image
// sizing and Pillow-exact bicubic resize). Copyright (c) 2026 Abdur Rahim, MIT License; see
// THIRD_PARTY_NOTICES.md.
//
// What is different from DigUp's runtime, for speed: every request is a group of inputs from many files,
// sorted by length and packed into as few llama.cpp calls as fit (DigUp runs one file at a time, up to 16
// inputs per call), and images go from ImageIO's decoder straight to the encoder without a JPEG round trip
// through a temporary file.
//
// Protocol, on stdin and stdout: every message is a little-endian u32 byte count and that many bytes.
//   request  'i'                                   -> status 0, JSON with the model's facts
//   request  't' u32 n, n x (u32 len, utf-8)       -> status 0, u32 n, u32 dim, u32 tokens, n x dim f32
//   request  'm' u32 budget, u32 n, n x (u32 len, path)
//                                                  -> status 0, u32 n, u32 dim, n x (u8 1, dim f32 | u8 0, u32 len, why)
//   request  'q'                                   -> exits
// A failed request answers status 1, u32 len, message. Logs go to stderr only.

#include "llama.h"
#include "mtmd.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#ifdef __APPLE__
#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>
#include <ImageIO/ImageIO.h>
#endif

// Which vectors this helper makes. Bump it with anything that changes them (llama.cpp tag, framing,
// image sizing): zsearch then embeds everything again rather than mix incomparable vectors.
static const int VECTOR_VERSION = 2;   // 2: pooling as the model says (Granite: its CLS token)

struct Options {
    std::string model;
    std::string mmproj;
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
        mtmd_log_set(log_callback, nullptr);
        llama_backend_init();
        llama_model_params mp = llama_model_default_params();
        mp.n_gpu_layers = 999;
        model = llama_model_load_from_file(opt.model.c_str(), mp);
        if (!model) throw std::runtime_error("can't load " + opt.model);
        vocab = llama_model_get_vocab(model);
        dim = llama_model_n_embd_out(model);
        row_size = llama_model_n_embd_inp(model);
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

        if (!opt.mmproj.empty()) {
            mtmd_context_params p = mtmd_context_params_default();
            p.use_gpu = true;
            p.print_timings = false;
            p.warmup = true;
            p.n_threads = threads;
            p.image_min_tokens = 1;   // never rescaled by mtmd: images arrive at their final size
            p.image_max_tokens = 1120;
            media = mtmd_init_from_file(opt.mmproj.c_str(), model, p);
            if (!media) throw std::runtime_error("can't load " + opt.mmproj);
        }
    }

    ~Embedder() {
        if (batch) llama_batch_ext_free(batch);
        if (media) mtmd_free(media);
        if (ctx) llama_free(ctx);
        if (model) llama_model_free(model);
    }

    int dimension() const { return dim; }
    bool images() const {
#ifdef __APPLE__
        return media != nullptr && mtmd_support_vision(media);
#else
        return false;
#endif
    }
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

    struct ImageResult {
        bool ok = false;
        std::string why;
    };

    // One vector per image (`dim` floats each, zeros where it failed). Each image is encoded on its own; their
    // rows then go through the text model packed together, as texts are.
    std::vector<float> embed_images(const std::vector<std::string> & paths, int budget, std::vector<ImageResult> & results) {
        std::vector<float> out(paths.size() * (size_t) dim, 0.0f);
        results.assign(paths.size(), ImageResult{});
        if (!images()) {
            for (auto & r : results) r.why = "images need the media model on macOS";
            return out;
        }
        std::vector<size_t> members;
        int used = 0;
        auto flush = [&]() {
            if (members.empty()) return;
            try {
                run(members, out);
                for (size_t m : members) results[m].ok = true;
            } catch (const std::exception & e) {
                for (size_t m : members) results[m].why = e.what();
            }
            members.clear();
            used = 0;
        };
        reset();
        for (size_t i = 0; i < paths.size(); i++) {
            std::vector<float> rows;
            std::vector<llama_token> before, after;
            int n_rows = 0;
            try {
                n_rows = encode_image(paths[i], budget, before, rows, after);
            } catch (const std::exception & e) {
                results[i].why = e.what();
                continue;
            }
            int n = (int) before.size() + n_rows + (int) after.size();
            if (n > opt.batch_tokens) {
                results[i].why = "image needs more tokens than a batch holds";
                continue;
            }
            if (!members.empty() && ((int) members.size() == opt.max_seqs || used + n > opt.batch_tokens)) flush();
            begin();
            for (llama_token t : before) add_token(t);
            for (int r = 0; r < n_rows; r++) add_row(rows.data() + (size_t) r * row_size);
            for (llama_token t : after) add_token(t);
            members.push_back(i);
            used += n;
        }
        flush();
        return out;
    }

  private:
    Options opt;
    llama_model * model = nullptr;
    llama_context * ctx = nullptr;
    llama_batch_ext * batch = nullptr;
    mtmd_context * media = nullptr;
    const llama_vocab * vocab = nullptr;
    int dim = 0;
    int row_size = 0;
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

    void add_row(const float * row) {
        llama_embd e{row, 1, (size_t) row_size};   // copied by the batch
        place(llama_batch_ext_add_embd(batch, sequences - 1, e));
    }

    // Runs the batch; writes each sequence's mean-pooled, L2-normalized vector to out[members[seq]].
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

    // Encodes one image: the tokens around it and its rows for the text model. Returns the row count.
    int encode_image(const std::string & path, int budget, std::vector<llama_token> & before, std::vector<float> & rows,
                     std::vector<llama_token> & after);
};

// ------------------------------------------------------------------------------------- image sizing --

// The reference's sizing (transformers' Gemma 4 image processor): fill `budget` soft tokens, each 3 x 3
// patches of 16 px, keeping the aspect ratio; each side rounded down to a multiple of 48 px.
static bool target_size(int height, int width, int budget, int & out_h, int & out_w) {
    const int patch = 16, pooling = 3;
    const int max_patches = budget * pooling * pooling;
    double factor = std::sqrt((double) (max_patches * patch * patch) / ((double) height * width));
    const int side = pooling * patch;
    int th = (int) std::floor(factor * height / side) * side;
    int tw = (int) std::floor(factor * width / side) * side;
    if (th == 0 && tw == 0) return false;
    const int max_side = (max_patches / (pooling * pooling)) * side;
    if (th == 0) {
        th = side;
        tw = std::min(width / height * side, max_side);
    } else if (tw == 0) {
        tw = side;
        th = std::min(height / width * side, max_side);
    }
    out_h = th;
    out_w = tw;
    return true;
}

// Pillow's bicubic resampling of packed RGB (a = -0.5, the kernel widened when shrinking, 22-bit fixed point).
namespace bicubic {
static const int PRECISION = 22;

static double filter(double v) {
    double x = std::fabs(v), a = -0.5;
    if (x < 1) return ((a + 2) * x - (a + 3)) * x * x + 1;
    if (x < 2) return (((x - 5) * x + 8) * x - 4) * a;
    return 0;
}

static void coefficients(int in, int out, std::vector<int> & bounds, std::vector<int32_t> & weights, int & size) {
    double scale = (double) in / out;
    double fscale = std::max(scale, 1.0);
    double support = 2 * fscale;
    size = (int) std::ceil(support) * 2 + 1;
    bounds.assign((size_t) out * 2, 0);
    weights.assign((size_t) out * size, 0);
    std::vector<double> row((size_t) size);
    for (int o = 0; o < out; o++) {
        double center = (o + 0.5) * scale;
        int first = std::max((int) (center - support + 0.5), 0);
        int count = std::min((int) (center + support + 0.5), in) - first;
        double total = 0;
        for (int x = 0; x < size; x++) {
            row[x] = x < count ? filter((x + first - center + 0.5) / fscale) : 0;
            total += row[x];
        }
        for (int x = 0; x < size; x++) {
            double w = x < count && total != 0 ? row[x] / total : row[x];
            weights[(size_t) o * size + x] = (int32_t) (w * (double) (1 << PRECISION) + (w < 0 ? -0.5 : 0.5));
        }
        bounds[(size_t) o * 2] = first;
        bounds[(size_t) o * 2 + 1] = count;
    }
}

static uint8_t clip(int32_t v) {
    v >>= PRECISION;
    return (uint8_t) (v < 0 ? 0 : v > 255 ? 255 : v);
}

static std::vector<uint8_t> horizontal(const uint8_t * src, int in_w, int rows, int out_w) {
    std::vector<int> bounds;
    std::vector<int32_t> weights;
    int size;
    coefficients(in_w, out_w, bounds, weights, size);
    std::vector<uint8_t> out((size_t) out_w * rows * 3);
    for (int y = 0; y < rows; y++) {
        for (int x = 0; x < out_w; x++) {
            const uint8_t * p = src + ((size_t) y * in_w + bounds[(size_t) x * 2]) * 3;
            int32_t r = 1 << (PRECISION - 1), g = r, b = r;
            for (int k = 0; k < bounds[(size_t) x * 2 + 1]; k++) {
                int32_t w = weights[(size_t) x * size + k];
                r += (int32_t) p[0] * w;
                g += (int32_t) p[1] * w;
                b += (int32_t) p[2] * w;
                p += 3;
            }
            size_t o = ((size_t) y * out_w + x) * 3;
            out[o] = clip(r);
            out[o + 1] = clip(g);
            out[o + 2] = clip(b);
        }
    }
    return out;
}

static std::vector<uint8_t> vertical(const uint8_t * src, int in_h, int row_w, int out_h) {
    std::vector<int> bounds;
    std::vector<int32_t> weights;
    int size;
    coefficients(in_h, out_h, bounds, weights, size);
    size_t stride = (size_t) row_w * 3;
    std::vector<uint8_t> out(stride * out_h);
    std::vector<int32_t> sums(stride);
    for (int y = 0; y < out_h; y++) {
        std::fill(sums.begin(), sums.end(), 1 << (PRECISION - 1));
        for (int k = 0; k < bounds[(size_t) y * 2 + 1]; k++) {
            const uint8_t * row = src + (size_t) (bounds[(size_t) y * 2] + k) * stride;
            int32_t w = weights[(size_t) y * size + k];
            for (size_t i = 0; i < stride; i++) sums[i] += (int32_t) row[i] * w;
        }
        for (size_t i = 0; i < stride; i++) out[(size_t) y * stride + i] = clip(sums[i]);
    }
    return out;
}

static std::vector<uint8_t> resize(const uint8_t * src, int w, int h, int to_w, int to_h) {
    if (to_w != w && to_h != h) {
        std::vector<uint8_t> pass = horizontal(src, w, h, to_w);
        return vertical(pass.data(), h, to_w, to_h);
    }
    if (to_w != w) return horizontal(src, w, h, to_w);
    if (to_h != h) return vertical(src, h, w, to_h);
    return std::vector<uint8_t>(src, src + (size_t) w * h * 3);
}
}  // namespace bicubic

// ---------------------------------------------------------------------------------------- decoding --

#ifdef __APPLE__
// Smaller than this on its longer side: an icon or a thumbnail, left out (as DigUp leaves them out).
static const int MIN_SIDE = 256;
// Larger than this: refused before decoding (a crafted PNG can expand to gigapixels).
static const double MAX_PIXELS = 200e6;

template <typename T> struct CF {
    T ref;
    explicit CF(T r) : ref(r) {}
    ~CF() { if (ref) CFRelease(ref); }
    CF(const CF &) = delete;
    CF & operator=(const CF &) = delete;
};

// Decodes `path` with ImageIO straight to at most `max_pixel` on its longer side, as packed RGB, upright.
static std::vector<uint8_t> decode(const std::string & path, int max_pixel, int & w, int & h) {
    CF<CFURLRef> url(CFURLCreateFromFileSystemRepresentation(nullptr, (const UInt8 *) path.data(), (CFIndex) path.size(), false));
    if (!url.ref) throw std::runtime_error("bad path");
    const void * keys0[] = {kCGImageSourceShouldCache};
    const void * vals0[] = {kCFBooleanFalse};
    CF<CFDictionaryRef> open_opts(CFDictionaryCreate(nullptr, keys0, vals0, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks));
    CF<CGImageSourceRef> source(CGImageSourceCreateWithURL(url.ref, open_opts.ref));
    if (!source.ref || CGImageSourceGetCount(source.ref) < 1) throw std::runtime_error("not an image");
    CF<CFDictionaryRef> props(CGImageSourceCopyPropertiesAtIndex(source.ref, 0, nullptr));
    int pw = 0, ph = 0;
    if (props.ref) {
        CFNumberRef n;
        if ((n = (CFNumberRef) CFDictionaryGetValue(props.ref, kCGImagePropertyPixelWidth))) CFNumberGetValue(n, kCFNumberIntType, &pw);
        if ((n = (CFNumberRef) CFDictionaryGetValue(props.ref, kCGImagePropertyPixelHeight))) CFNumberGetValue(n, kCFNumberIntType, &ph);
    }
    if (std::max(pw, ph) < MIN_SIDE) throw std::runtime_error("too small");
    if ((double) pw * ph > MAX_PIXELS) throw std::runtime_error("too large to decode");
    CF<CFNumberRef> max_ref(CFNumberCreate(nullptr, kCFNumberIntType, &max_pixel));
    const void * keys[] = {kCGImageSourceCreateThumbnailFromImageAlways, kCGImageSourceThumbnailMaxPixelSize,
                           kCGImageSourceCreateThumbnailWithTransform, kCGImageSourceShouldCacheImmediately};
    const void * vals[] = {kCFBooleanTrue, max_ref.ref, kCFBooleanTrue, kCFBooleanTrue};
    CF<CFDictionaryRef> thumb_opts(CFDictionaryCreate(nullptr, keys, vals, 4, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks));
    CF<CGImageRef> image(CGImageSourceCreateThumbnailAtIndex(source.ref, 0, thumb_opts.ref));
    if (!image.ref) throw std::runtime_error("can't decode image");
    w = (int) CGImageGetWidth(image.ref);
    h = (int) CGImageGetHeight(image.ref);
    if (w <= 0 || h <= 0) throw std::runtime_error("empty image");
    std::vector<uint8_t> rgba((size_t) w * h * 4);
    CF<CGColorSpaceRef> space(CGColorSpaceCreateWithName(kCGColorSpaceSRGB));
    CF<CGContextRef> context(CGBitmapContextCreate(rgba.data(), (size_t) w, (size_t) h, 8, (size_t) w * 4, space.ref,
                                                   (uint32_t) kCGImageAlphaNoneSkipLast | (uint32_t) kCGBitmapByteOrder32Big));
    if (!context.ref) throw std::runtime_error("can't draw image");
    // Transparent pixels over white, as a viewer shows them.
    CGContextSetRGBFillColor(context.ref, 1, 1, 1, 1);
    CGContextFillRect(context.ref, CGRectMake(0, 0, w, h));
    CGContextDrawImage(context.ref, CGRectMake(0, 0, w, h), image.ref);
    std::vector<uint8_t> rgb((size_t) w * h * 3);
    for (size_t i = 0, j = 0; i < rgba.size(); i += 4, j += 3) {
        rgb[j] = rgba[i];
        rgb[j + 1] = rgba[i + 1];
        rgb[j + 2] = rgba[i + 2];
    }
    return rgb;
}
#endif

int Embedder::encode_image(const std::string & path, int budget, std::vector<llama_token> & before, std::vector<float> & rows,
                           std::vector<llama_token> & after) {
#ifdef __APPLE__
    int w = 0, h = 0;
    // DigUp decodes photos at most 1024 px and screenshots 1536 px; larger budgets need more pixels.
    std::vector<uint8_t> rgb = decode(path, budget >= 280 ? 1536 : 1024, w, h);
    int th, tw;
    if (!target_size(h, w, budget, th, tw)) throw std::runtime_error("image too thin to embed");
    if (th != h || tw != w) rgb = bicubic::resize(rgb.data(), w, h, tw, th);
    mtmd_bitmap * bitmap = mtmd_bitmap_init((uint32_t) tw, (uint32_t) th, rgb.data());
    if (!bitmap) throw std::runtime_error("can't make a bitmap");
    mtmd_input_chunks * chunks = mtmd_input_chunks_init();
    const char * marker = mtmd_default_marker();
    mtmd_input_text text{marker, strlen(marker), true, true};
    const mtmd_bitmap * bitmaps[] = {bitmap};
    int32_t status = mtmd_tokenize(media, chunks, &text, bitmaps, 1);
    mtmd_bitmap_free(bitmap);
    if (status != 0) {
        mtmd_input_chunks_free(chunks);
        throw std::runtime_error("can't tokenize image (" + std::to_string(status) + ")");
    }
    int n_rows = 0;
    bool seen_image = false;
    for (size_t i = 0; i < mtmd_input_chunks_size(chunks); i++) {
        const mtmd_input_chunk * chunk = mtmd_input_chunks_get(chunks, i);
        if (mtmd_input_chunk_get_type(chunk) == MTMD_INPUT_CHUNK_TYPE_TEXT) {
            size_t count = 0;
            const llama_token * t = mtmd_input_chunk_get_tokens_text(chunk, &count);
            auto & dst = seen_image ? after : before;
            dst.insert(dst.end(), t, t + count);
        } else {
            if (seen_image || mtmd_encode_chunk(media, chunk) != 0) {
                mtmd_input_chunks_free(chunks);
                throw std::runtime_error("the encoder failed");
            }
            n_rows = (int) mtmd_input_chunk_get_n_tokens(chunk);
            const float * out = mtmd_get_output_embd(media);
            rows.assign(out, out + (size_t) n_rows * row_size);
            seen_image = true;
        }
    }
    mtmd_input_chunks_free(chunks);
    if (!seen_image) throw std::runtime_error("no image in the input");
    return n_rows;
#else
    (void) path; (void) budget; (void) before; (void) rows; (void) after;
    throw std::runtime_error("images need macOS");
#endif
}

// -------------------------------------------------------------------------------------------- main --

static void usage() {
    fprintf(stderr,
            "usage: zsearch-embed --model TEXT.gguf [--mmproj MEDIA.gguf] [--threads N] [--batch-tokens N]\n"
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
        else if (a == "--mmproj") opt.mmproj = next();
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
                         "{\"dim\":%d,\"images\":%s,\"vectorVersion\":%d,\"batchTokens\":%d,\"maxSeqs\":%d,\"maxInput\":%d}",
                         embedder->dimension(), embedder->images() ? "true" : "false", VECTOR_VERSION, o.batch_tokens,
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
            } else if (op == 'm') {
                int budget = (int) r.u32();
                if (budget != 70 && budget != 140 && budget != 280 && budget != 560 && budget != 1120) {
                    throw std::runtime_error("budget must be 70, 140, 280, 560 or 1120");
                }
                uint32_t count = r.u32();
                std::vector<std::string> paths;
                for (uint32_t i = 0; i < count; i++) paths.push_back(r.str());
                std::vector<Embedder::ImageResult> results;
                std::vector<float> vectors = embedder->embed_images(paths, budget, results);
                Writer w;
                w.u8(0);
                w.u32(count);
                w.u32((uint32_t) embedder->dimension());
                for (uint32_t i = 0; i < count; i++) {
                    if (results[i].ok) {
                        w.u8(1);
                        w.floats(vectors.data() + (size_t) i * embedder->dimension(), (size_t) embedder->dimension());
                    } else {
                        w.u8(0);
                        w.str(results[i].why.substr(0, 300));
                    }
                }
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
