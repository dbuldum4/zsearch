# Gemma on Mac

This change keeps EmbeddingGemma 2's existing Q8_0 model, prompts, passage boundaries,
token limits, pooling and 16-bit stored vectors. It changes how llama.cpp computes
attention and supplies weights to Accelerate, rather than reducing the amount of
text indexed or using a smaller model.

## Changes

- Independent passages used to share a dense attention matrix, with cross-passage
  scores masked out afterward. On Mac, EmbeddingGemma 2 now computes attention
  within each passage and concatenates the outputs. Projections and feed-forward
  layers still run together. Shared/interleaved sequences take the original path;
  graph reuse checks the exact passage boundaries. Linux keeps the original path.
- Accelerate can keep up to 512 MiB of decoded, immutable model weights per helper
  context. It avoids decoding the same quantized matrices and launching conversion
  threads on every batch. Activations are never cached. This uses the same decoded
  float values and only applies to the Accelerate backend.
- Apple-silicon builds explicitly target M1-compatible FP16 and dot-product
  instructions while keeping `GGML_NATIVE=OFF` for portable releases.

The helper still attempts full Metal offload. The measurements below used the
virtual M1 runner's CPU; they do not establish speed on a physical Mac's GPU or
Neural Engine. No Core ML/ANE conversion is included. Flash attention stays `auto`:
forcing it on slightly improved some timings but changed more nearest neighbours.

For diagnosis, set `ZSEARCH_EMBED_DENSE_ATTN=1` to restore dense attention, or
`ZSEARCH_EMBED_NO_BLAS_CACHE=1` to avoid the extra decoded-weight memory. These are
helper environment switches, not settings that require an index rebuild.

## Measurements

The [cold-index run](https://github.com/dbuldum4/zsearch/actions/runs/38328564371)
used an Apple M1 (Virtual), three CPU cores, macOS `macos-latest`, original helper
commit `9f64f96`, and optimized commit `40c0a82`. Later cache lifecycle checks do
not change the normal calculation. [Raw results](mac-benchmark.json) include the
model checksum and all tested variants.

The production `SemanticIndexer` used its default 70% index load (two threads).
Both helpers indexed the same generated corpus: 438 catalog entries, 178 eligible
files, 561 unique passages and 235,219 tokens. Each started with an empty semantic
store: zero vectors reused. Timing includes helper/model startup and creating the
decoded-weight cache. Extraction ran once and its time is included in both totals.
Passage hashes and vector counts must agree or the benchmark fails.

| Cold index | Original | Optimized |
| --- | ---: | ---: |
| Semantic indexing | 948.07 s | 532.60 s |
| Including extraction | 948.48 s | 533.02 s |
| Speedup | | **1.78×** |

Stored vectors compared by identical passage hash had minimum cosine **0.999563**
and mean **0.999902** against the original. Different attention shapes change
floating-point rounding; this is not bit-for-bit equivalence.

The same run's shorter runtime comparison used 66 passages / 14,930 tokens and
15 queries, with default helper thread settings (three threads). It took 54.36 s
originally and 35.92 s optimized (**1.51×**), retained **98.67%** of the original top
ten neighbours, and kept the first neighbour for all 15 queries. These small
fixtures check drift, not retrieval quality across every real collection.

An [earlier split-attention run without the weight cache](https://github.com/dbuldum4/zsearch/actions/runs/38327753747)
took 55.09 s → 25.64 s (**2.15×**) for the same 66-passage workload, with the same
quality scores. Runner timings vary, so the cold-index comparison above is the
end-to-end result rather than a promised speedup for every Mac or workload.

## Run manually

These scripts are intentionally outside CI. The temporary experiment workflows
are absent from this PR's final tree.

From a checkout of this PR on a Mac with Bun, CMake and a C++ compiler:

```sh
bun install --frozen-lockfile
scripts/build-embed.sh
git worktree add --detach work/baseline-source 9f64f96
(cd work/baseline-source && scripts/build-embed.sh)
mkdir -p work/baseline
cp work/baseline-source/dist/zsearch-embed work/baseline/zsearch-embed

# Downloads and verifies the public Q8_0 model into work/models if not supplied.
# Median of three repeated identical embedding calls, plus neighbour comparisons.
bun scripts/bench-semantic/runtime.ts --rounds=3

# Fresh vectors for each helper, using the real production indexing path.
bun scripts/bench-semantic/compare-indexing.ts \
  --baseline=work/baseline/zsearch-embed --tool=dist/zsearch-embed \
  --model=work/models/embeddinggemma-2-Q8_0.gguf
```

The runtime script reads the checkout's README files as well as `evals.json`, so
later documentation edits can change its passage count. The cold-index corpus is
generated with a fixed seed. Results are written under `work/` and are not added
to the repository automatically.
