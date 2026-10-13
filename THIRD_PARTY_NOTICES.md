# Third-party notices

zsearch is MIT licensed (see LICENSE). Search by meaning (src/semantic, native/embed) adapts code
from DigUp and builds on llama.cpp, and runs a model that is downloaded on request, not shipped.

## DigUp

https://github.com/ARahim3/DigUp, at commit 6faa29e. Adapted in zsearch:

- `src/semantic/search.ts`: the hybrid ranking of `Sources/DigUpKit/Searcher.swift` (meaning scores
  per query, the gates, word coverage, lookups, kind hints, stopwords).
- `src/semantic/chunk.ts`: passage size, the prompts and `hasWords` from `DocExtractor` and
  `SearchText`.
- `src/semantic/model.ts`: the model files, revision and checksums of `ModelFiles.swift`.
- `native/embed/zsearch-embed.cpp`: framing, pooling and image handling from
  `Sources/LlamaRuntime/LlamaEmbedder.swift` and `ImageSizing.swift`.
- `native/embed/llama.cpp-no-logits.patch`: DigUp's patch, unchanged.

```text
MIT License

Copyright (c) 2026 Abdur Rahim

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## llama.cpp

https://github.com/ggml-org/llama.cpp, tag b11461. Fetched and built by `scripts/build-embed.sh`
and linked into `zsearch-embed` (in the Mac app: `Contents/Helpers/zsearch-embed`).

```text
MIT License

Copyright (c) 2023-2026 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## potion-retrieval-32M

Minish Lab's potion-retrieval-32M (`minishlab/potion-retrieval-32M` at revision
6fc8051fab2a1e0ee76689cf08c853792ac285e7), a Model2Vec static embedding model, MIT License
(https://huggingface.co/minishlab/potion-retrieval-32M). zsearch doesn't include it: the Mac app
(when it starts) or `zsearch semantic install` downloads it from Hugging Face and checks its
checksums. `src/semantic/potion.ts` runs it the way Model2Vec (MIT,
https://github.com/MinishLab/model2vec) does.

## granite-embedding-small-english-r2

IBM's granite-embedding-small-english-r2, Apache License 2.0
(https://huggingface.co/ibm-granite/granite-embedding-small-english-r2), in mradermacher's 8-bit
GGUF conversion (`mradermacher/granite-embedding-small-english-r2-GGUF` at revision
2b2ad9b58f3e382821e007f4c924101d6bd4a5e2). zsearch doesn't include it: it is downloaded the same
way and its SHA-256 checked.
