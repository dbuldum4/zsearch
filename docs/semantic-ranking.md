# Granite semantic ranking

Semantic search uses one pinned model: IBM's `granite-embedding-small-english-r2`, in the 52 MB Q8_0 GGUF conversion, with the native llama.cpp helper and CLS pooling. Potion is no longer downloaded, indexed, queried or blended into results.

## Pipeline

- Extract text once in the main index. A worker cuts stored text into passages while Granite embeds the previous batch. The helper sorts and packs passages into model calls.
- Hash each exact document prompt and embed it once. Copies, moves, rebuilds and unchanged passages reuse their stored vectors. The existing Granite database path and vector fingerprint are preserved.
- Commit progress as files finish. Long files get their first 40 passages before the rest. Cancellation and helper failures leave committed vectors available to the next indexing run.
- Search uses the vectors of each file whose text is as it was embedded, and ranks the rest by their words (see [While Granite catches up](#while-granite-catches-up)). Snapshots made by another model or helper, or for an earlier build of the main index, are not used at all. Publish the completion marker only after every file and passage has been processed: a completed pass becomes searchable immediately, even within the normal vector reload interval; a pass still running is reloaded at most every 15 seconds.
- Normalize cosine similarities per query. Each file takes its best passage, discounted by `0.7 * log(passages)` and `0.5 * log(shared copies)`. A squared filename/folder coverage boost adds at most 2, and body-word coverage adds at most 3, rarer words counting for more (by IDF, as without vectors). Files still need half of the query's words, counted plainly, to be candidates by words. Code and number lookups retain their stronger exact-word preference and count every word the same.
- Enforce file filters and content authorization. Directories and Lean proofs stay out of semantic results. Saved-name lookups show document headings; natural-language results show the matching passage.

Digit-only passages deliberately have no vectors and still count as processed. A referenced vector that is missing makes that file pending.

## While Granite catches up

The semantic index records, for each file, what its passages were made from: size, modification time, text length, title and, for recordings, the transcription language. At search time a file's vectors count only if the file is still one the semantic pass would embed under the current settings (indexed text, content allowed for its folder, not a key or password file, not excluded, code only with `semantic.code`, recordings only with transcription on) and that record matches it and every passage is stored. Other files' passages neither match nor set the scale of meaning scores, so a deleted, excluded, names-only, changed or no longer embedded file is never shown by an old vector, before or after the next pass.

Files that should have vectors and don't (new, changed since, or partly embedded) are pending. A pending file that holds enough of the query's words to be a word candidate gets a stand-in meaning score of `2.0 × coverage` (the meaning gate times the plain share of the query's words it holds), then the usual word, name and kind evidence. Holding every word, it ranks above files with the same words that stand out less than the gate by meaning, and below files that stand out more; holding half, it gets half that. With nothing pending, results are exactly those of a completed pass.

Responses carry `semantic: { files, current, pending, matched }` (`matched`: pending files among the results), and while files are pending the strategy line reads `semantic + words · 9,812 of 9,830 files current; 18 pending matched by words`. The Mac app, terminal app and CLI show that line as they show any strategy.

## Words only

Without usable vectors (semantic search off, no model or helper, vectors of another model or helper, a rebuilt main index, or no file current yet), results come from word matches alone, without starting a query helper. They are ordered by body-word coverage (rarer words counting for more, by IDF), the filename/folder boost, and up to 0.5 from keyword search's BM25 order of the query's content words. A query with more than six content words needs only three of them to match.

On BEIR SciFact (5,183 abstracts, 300 dev queries; `bun scripts/semantic-bench.ts --dataset=DIR --no-granite`), words-only nDCG@10 rose from 0.465 to 0.612 and recall@100 from 0.590 to 0.794. On the development sets below, words-only nDCG@10 went from 0.723 to 0.731 (tuning), 0.529 to 0.570 (validation) and stayed 0.850 (audit). Granite-stage ranking is unchanged.

## Measurements

A bounded real-model check on 2026-10-13 used 20 package documents per set, without the optional handbook PDFs. The authored corpus contributes 49 notes to tuning and 57 to validation/audit. The rebuilt helper reports vector version 2 and uses CLS pooling; no stand-in model is involved.

| Development set | Queries | Words nDCG@10 | Granite nDCG@10 | Granite recall@10 |
| --- | ---: | ---: | ---: | ---: |
| Tuning | 37 | 0.710 | 0.913 | 0.946 |
| Validation | 18 | 0.550 | 0.927 | 1.000 |
| Audit | 20 | 0.850 | 0.966 | 0.975 |

Handbook and résumé lookups retain the intended file first, and the plumber-cost query returns the payment note first. Remaining tuning weaknesses include tenancy notice, car maintenance and vegetarian dinner queries; `job application` returns no hits. These are visible limitations of the current single-model ranking, not claims of parity with the earlier ensemble. The full distractor/PDF benchmark was not completed in this check.

[Per-query results and aggregate metrics](benchmarks/semantic-ranking.json) record this Granite-only run. No ranking parameters were changed based on these new measurements.

## Public benchmarks

[Public benchmarks](public-benchmarks.md) (BEIR, NanoBEIR, LongEmbed and EnronQA, about 9,200 queries, and searches made by hand) measure the same search on files it was not tuned on, against Granite's published MTEB scores. They led to the IDF-weighted body-word coverage above (it was plain coverage adding at most 1): EnronQA mail +0.105 nDCG@10, QMSum transcripts +0.116, with the authored sets at 0.925 (tuning), 0.938 (validation) and 0.991 (audit).

## Evaluate

Install the model and build the native helper, then run:

```sh
bun scripts/semantic-eval.ts --stage=all --packages=20 --json=tuning.json --verbose
bun scripts/semantic-eval.ts --stage=all --packages=20 --holdout --json=validation.json --verbose
bun scripts/semantic-eval.ts --stage=all --packages=20 --audit --json=audit.json --verbose
```

Omit `--packages=20` to include all installed package documents. `--stage=words` needs no model; `--stage=full` evaluates complete Granite. `--tool=PATH` selects the helper, and `ZSEARCH_MODELS` selects a directory holding its GGUF. `--pdf-dir=DIR` optionally adds `ACT-UserHandbook.pdf` and `SHS Handbook 26-27.pdf`; questions requiring missing PDFs are omitted. `--word-vectors=FILE` explicitly substitutes a stand-in.

The evaluator creates an isolated corpus with authored notes and package-document distractors. It restores its data environment, closes helpers and removes temporary files. Scores are nDCG@10, MRR@10 and recall@10, with up to 50 returned hits.

The earlier two-model measurements remain available in [the previous PR revision](https://github.com/dbuldum4/zsearch/blob/d8621de5339376f1c9c9856c15b3873c70306dcb/docs/semantic-ranking.md); they do not describe this Granite-only pipeline. These authored query sets have informed development and are not untouched generalization estimates.

Validation: 323 Bun tests passed, 2 real Apple OCR tests skipped, zero failures; 32 Swift tests passed. Strict type checking, the standalone engine build and the current native-helper build passed. Regression checks cover Granite-only installation, missing-helper blocking, snapshot invalidation, partial-query suppression, immediate replacement loading, numeric passages, missing vectors and cancellation/resumption of long files. SwiftUI views require a macOS build; the Swift tests here ran on Linux.
