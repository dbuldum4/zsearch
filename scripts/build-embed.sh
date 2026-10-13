#!/bin/bash
# Build the semantic search helper, dist/zsearch-embed (native/embed), on llama.cpp (MIT).
#
#   scripts/build-embed.sh              # for this machine (Metal on macOS, the CPU on Linux)
#   scripts/build-embed.sh --portable   # no CPU-specific instructions (release builds)
#
# llama.cpp is fetched once at the pinned tag into native/embed/vendor (not in git) and patched so
# that an embedding model reserves no logits (the patch comes from DigUp). Needs git, CMake and a
# C++17 compiler. Nothing is downloaded at build time besides llama.cpp's source.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# The first llama.cpp tags with EmbeddingGemma 2 (text, vision and audio) are b11452 and later.
# A new tag changes the vectors only if the helper's VECTOR_VERSION says so: check before bumping.
TAG=b11461
PATCH="$ROOT/native/embed/llama.cpp-no-logits.patch"
SOURCE="$ROOT/native/embed/vendor/llama.cpp"
BUILD="$ROOT/native/embed/vendor/build"
PORTABLE=0
[ "${1:-}" = "--portable" ] && PORTABLE=1

if [ ! -d "$SOURCE/.git" ]; then
  mkdir -p "$(dirname "$SOURCE")"
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$TAG" https://github.com/ggml-org/llama.cpp "$SOURCE"
elif [ "$(git -C "$SOURCE" describe --tags --exact-match 2>/dev/null)" != "$TAG" ]; then
  git -C "$SOURCE" fetch --quiet --depth 1 origin tag "$TAG"
  git -C "$SOURCE" checkout --quiet --force "$TAG"
fi
# Without the patch, every input token costs 1 MiB of logits that an embedding model never produces.
if git -C "$SOURCE" apply --check "$PATCH" 2>/dev/null; then
  git -C "$SOURCE" apply "$PATCH"
fi

ATTENTION_PATCH="$ROOT/native/embed/llama.cpp-sequence-attention.patch"
if git -C "$SOURCE" apply --check "$ATTENTION_PATCH" 2>/dev/null; then
  git -C "$SOURCE" apply "$ATTENTION_PATCH"
elif ! git -C "$SOURCE" apply --reverse --check "$ATTENTION_PATCH" 2>/dev/null; then
  echo "error: sequence-attention patch does not match llama.cpp $TAG" >&2
  exit 1
fi

FLAGS=(-DCMAKE_BUILD_TYPE=Release -DLLAMA_SOURCE="$SOURCE")
if [ "$(uname)" = Darwin ]; then
  FLAGS+=(-DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DCMAKE_OSX_DEPLOYMENT_TARGET=14.0 -DGGML_NATIVE=OFF)
  JOBS=$(sysctl -n hw.ncpu)
else
  JOBS=$(nproc)
  [ "$PORTABLE" = 1 ] && FLAGS+=(-DGGML_NATIVE=OFF)
fi
GENERATOR=()
command -v ninja > /dev/null && GENERATOR=(-G Ninja)
cmake -S "$ROOT/native/embed" -B "$BUILD" ${GENERATOR[@]+"${GENERATOR[@]}"} "${FLAGS[@]}" > /dev/null
cmake --build "$BUILD" --config Release --target zsearch-embed -j "$JOBS" > /dev/null
mkdir -p "$ROOT/dist"
cp "$BUILD/zsearch-embed" "$ROOT/dist/zsearch-embed"
echo "Built $ROOT/dist/zsearch-embed (llama.cpp $TAG)"
