# Granite semantic ranking

Semantic search uses one pinned model: IBM's `granite-embedding-small-english-r2`, in the 52 MB Q8_0 GGUF conversion, with the native llama.cpp helper and CLS pooling. Potion is no longer downloaded, indexed, queried or blended into results.

## Pipeline

- Extract text once in the main index. A worker cuts stored text into passages while Granite embeds the previous batch. The helper sorts and packs passages into model calls.
- Hash each exact document prompt and embed it once. Copies, moves, rebuilds and unchanged passages reuse their stored vectors. The existing Granite database path and vector fingerprint are preserved.
- Commit progress as files finish. Long files get their first 40 passages before the rest. Cancellation and helper failures leave committed vectors available to the next indexing run.
- Publish the completion marker only after every file and passage has been processed. Search checks that marker against the current main-index sequence and generation before loading vectors. Partial or stale snapshots use current word matches without starting a query helper. A completed replacement becomes searchable immediately, even within the normal vector reload interval.
- Normalize cosine similarities per query. Each file takes its best passage, discounted by `0.7 * log(passages)` and `0.5 * log(shared copies)`. A squared filename/folder coverage boost adds at most 2, and body-word coverage adds at most 1. Code and number lookups retain their stronger exact-word preference.
- Enforce file filters and content authorization. Directories and Lean proofs stay out of semantic results. Saved-name lookups show document headings; natural-language results show the matching passage.

Digit-only passages deliberately have no vectors and still count as processed. A referenced vector that is missing makes a snapshot unusable.

## Words only

Until Granite completes, results come from word matches. They are ordered by body-word coverage (rarer words counting for more, by IDF), the filename/folder boost, and up to 0.5 from keyword search's BM25 order of the query's content words. A query with more than six content words needs only three of them to match.

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
