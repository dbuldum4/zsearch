#!/usr/bin/env python3
"""
A stand-in for EmbeddingGemma 2's text model, for timing the semantic index where the real
weights can't be downloaded: the same llama.cpp architecture (gemma-embedding2) and, as far as
the published file size tells, the same shapes, with random Q8_0 weights. Its vectors mean
nothing, but it costs what the real model costs to run, which is all a speed benchmark needs.

    python3 make-standin-model.py OUT.gguf CORPUS_DIR [--small]

The tokenizer is a SentencePiece vocabulary of the corpus's own character n-grams (about four
characters a token on English prose, like Gemma's), padded to Gemma's 262,144 entries.
`--small` makes a tiny model (for tests).

Needs numpy and llama.cpp's gguf-py (PYTHONPATH=native/embed/vendor/llama.cpp/gguf-py).
"""
import collections
import os
import sys

import numpy as np
import gguf
from gguf.quants import quantize

out, corpus = sys.argv[1], sys.argv[2]
small = "--small" in sys.argv

# Shapes: 24 layers of 768 with 3 heads of 256 (1 KV head) and a 1,152 FFN, per-layer inputs of
# 256, 768-wide output. With Gemma's vocabulary that is 309 M parameters, about the 310 MB of
# ggml-org's Q8_0 file. Assumed, not read from the real config (which isn't reachable here).
N_VOCAB = 262_144
N_EMBD, N_LAYER, N_FF, N_HEAD, N_HEAD_KV, HEAD_DIM, N_PER_LAYER, N_OUT = 768, 24, 1152, 3, 1, 256, 256, 768
if small:
    N_VOCAB, N_EMBD, N_LAYER, N_FF, N_HEAD, N_HEAD_KV, HEAD_DIM, N_PER_LAYER, N_OUT = 8192, 64, 2, 128, 2, 1, 32, 16, 64

# --- vocabulary --------------------------------------------------------------------------------
counts = collections.Counter()
seen = 0
for root, _, files in os.walk(corpus):
    for name in files:
        try:
            with open(os.path.join(root, name), encoding="utf-8", errors="ignore") as f:
                text = f.read(200_000)
        except OSError:
            continue
        for word in text.split():
            w = "▁" + word
            for n in range(2, min(len(w), 10) + 1):
                for i in range(len(w) - n + 1):
                    counts[w[i:i + n]] += 1
        seen += len(text)
        if seen > 40_000_000:
            break
special = ["<pad>", "<eos>", "<bos>", "<unk>"]
bytes_ = [f"<0x{b:02X}>" for b in range(256)]
budget = N_VOCAB - len(special) - len(bytes_) - 2000
# Printable pieces only: llama.cpp reads token texts as C strings.
ok = lambda p: p.isprintable() or all(c.isprintable() or c == "▁" for c in p)
singles = sorted({c for piece in counts for c in piece if ok(c)})[:2000]
pieces = [p for p, _ in counts.most_common() if len(p) > 1 and ok(p)][: budget - len(singles)]
tokens = special + bytes_ + singles + pieces
scores = [0.0] * len(special) + [0.0] * 256 + [-1e6] * len(singles) + [float(counts[p]) * (len(p) - 1) for p in pieces]
types = [3] * len(special) + [6] * 256 + [1] * (len(singles) + len(pieces))
while len(tokens) < N_VOCAB:
    tokens.append(f"<unused{len(tokens)}>")
    scores.append(-1e9)
    types.append(5)
tokens, scores, types = tokens[:N_VOCAB], scores[:N_VOCAB], types[:N_VOCAB]

# --- weights -----------------------------------------------------------------------------------
w = gguf.GGUFWriter(out, "gemma-embedding2")
w.add_name("embeddinggemma-2 stand-in (random weights)")
w.add_context_length(2048)
w.add_embedding_length(N_EMBD)
w.add_block_count(N_LAYER)
w.add_feed_forward_length(N_FF)
w.add_head_count(N_HEAD)
w.add_head_count_kv(N_HEAD_KV)
w.add_key_length(HEAD_DIM)
w.add_value_length(HEAD_DIM)
w.add_key_length_swa(HEAD_DIM)
w.add_value_length_swa(HEAD_DIM)
w.add_layer_norm_rms_eps(1e-6)
w.add_rope_freq_base(1_000_000.0)
w.add_rope_freq_base_swa(10_000.0)
w.add_rope_dimension_count(HEAD_DIM)
w.add_sliding_window(512)
# Every sixth layer attends to the whole input, the others to a window of 512 tokens.
w.add_sliding_window_pattern([(i + 1) % (6 if not small else 2) != 0 for i in range(N_LAYER)])
w.add_embedding_length_per_layer_input(N_PER_LAYER)
w.add_embedding_length_out(N_OUT)
w.add_causal_attention(False)
w.add_pooling_type(gguf.PoolingType.MEAN)
w.add_tokenizer_model("llama")
w.add_tokenizer_pre("default")
w.add_token_list(tokens)
w.add_token_scores(scores)
w.add_token_types(types)
w.add_bos_token_id(2)
w.add_eos_token_id(1)
w.add_unk_token_id(3)
w.add_pad_token_id(0)
w.add_add_bos_token(True)
w.add_add_eos_token(True)

rng = np.random.default_rng(1)


def tensor(name, shape, quant=True, scale=0.02):
    data = (rng.standard_normal(shape, dtype=np.float32) * scale).astype(np.float32)
    if quant and shape[-1] % 32 == 0:
        w.add_tensor(name, quantize(data, gguf.GGMLQuantizationType.Q8_0), raw_dtype=gguf.GGMLQuantizationType.Q8_0)
    else:
        w.add_tensor(name, data)


def norm(name, n):
    w.add_tensor(name, np.ones((n,), dtype=np.float32))


# numpy shapes are (rows, cols) = ggml's {cols, rows}
tensor("token_embd.weight", (N_VOCAB, N_EMBD))
tensor("per_layer_model_proj.weight", (N_PER_LAYER * N_LAYER, N_EMBD))
norm("per_layer_proj_norm.weight", N_PER_LAYER)
norm("output_norm.weight", N_EMBD)
tensor("output.weight", (N_OUT, N_EMBD))
for i in range(N_LAYER):
    b = f"blk.{i}"
    norm(f"{b}.attn_norm.weight", N_EMBD)
    tensor(f"{b}.attn_q.weight", (HEAD_DIM * N_HEAD, N_EMBD))
    tensor(f"{b}.attn_k.weight", (HEAD_DIM * N_HEAD_KV, N_EMBD))
    tensor(f"{b}.attn_v.weight", (HEAD_DIM * N_HEAD_KV, N_EMBD))
    tensor(f"{b}.attn_output.weight", (N_EMBD, HEAD_DIM * N_HEAD))
    norm(f"{b}.attn_q_norm.weight", HEAD_DIM)
    norm(f"{b}.attn_k_norm.weight", HEAD_DIM)
    norm(f"{b}.post_attention_norm.weight", N_EMBD)
    norm(f"{b}.ffn_norm.weight", N_EMBD)
    tensor(f"{b}.ffn_gate.weight", (N_FF, N_EMBD))
    tensor(f"{b}.ffn_up.weight", (N_FF, N_EMBD))
    tensor(f"{b}.ffn_down.weight", (N_EMBD, N_FF))
    norm(f"{b}.post_ffw_norm.weight", N_EMBD)
    tensor(f"{b}.inp_gate.weight", (N_PER_LAYER, N_EMBD))
    tensor(f"{b}.proj.weight", (N_EMBD, N_PER_LAYER))
    norm(f"{b}.post_norm.weight", N_EMBD)
    w.add_tensor(f"{b}.layer_output_scale.weight", np.ones((1,), dtype=np.float32))

w.write_header_to_file()
w.write_kv_data_to_file()
w.write_tensors_to_file()
w.close()
print(f"wrote {out}: {len(pieces)} n-gram pieces")
