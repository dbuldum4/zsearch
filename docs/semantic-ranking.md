# Semantic ranking measurements

PR 22 originally made Potion and partial Granite follow keyword order, and put every-word matches first once Granite finished. That helped handbook lookup but buried good natural-language answers beneath incidental word matches. These changes use finite evidence at each stage and remove partial Granite from search.

## Behavior

- Words-only search has a finite saved-name boost and a small every-word bonus. Question boilerplate such as “how”, “does” and “did” no longer consumes lexical coverage. Semantic results exclude directories.
- Potion uses semantic relevance with a squared filename/folder coverage boost of at most 2, and a long-document discount of 0.15 per log passage count. Incidental body words do not dominate its meaning scores.
- Complete Granite combines its normalized best-passage evidence equally with Potion's. Its length discount is 0.7; repeated passages get a 0.5 log discount. A finite body-word bonus of at most 1 supplements the name evidence. A strong match from either model preserves candidate eligibility, even when the other model fails to recognize the concept.
- Granite must have completed all passages for the current main-index sequence, and cover Potion's current file signatures. During indexing, after an edit, or following cancellation, search remains on Potion. Search-time passage reranking is removed. The growing Granite vector table is not loaded until its completion marker is published.
- Existing Granite indexes become eligible after their next successful semantic pass. Stored vectors are reused; this ranking change does not require re-embedding.
- Saved-name lookups show document headings. Handbook results now show their cover/title text instead of an arbitrary conduct paragraph or a one-word cross-reference. Natural-language queries still show the relevant passage, including the plumber's €180 payment.

## Measurements

Real pinned Potion and Granite models, the same Q8_0 helper with CLS pooling, four threads, 2048 batch tokens and 16 sequences. Compared PR head `f505748` with the final changes. The 40-query tuning corpus contains 49 authored notes, 203 package documents and actual ACT/SHS handbook PDFs. Validation and audit use eight additional documents and 20 queries each. Data includes both lexical and paraphrased searches, and code/ID lookups. All queries returned up to 50 hits; metrics score the first 10.

nDCG@10, weighted across all 80 queries:

| Stage | PR head | Tuned | Change |
|---|---:|---:|---:|
| words | 0.670 | 0.721 | +0.051 |
| potion | 0.827 | 0.956 | +0.129 |
| full | 0.925 | 0.977 | +0.052 |

Breakdown (before → after):

| Set | Words-only | Potion | Complete Granite |
|---|---:|---:|---:|
| tuning (40) | 0.703 → 0.753 | 0.842 → 0.979 | 0.901 → 0.979 |
| validation (20) | 0.478 → 0.548 | 0.712 → 0.941 | 0.920 → 0.982 |
| audit (20) | 0.797 → 0.832 | 0.912 → 0.927 | 0.979 → 0.968 |

Against latest main `1213953`, using the same corrected 40-query evaluator:

| Stage | Main | Tuned |
|---|---:|---:|
| words | 0.684 | 0.753 |
| potion | 0.928 | 0.979 |
| full | 0.909 | 0.979 |

## Actual-response judgments and limits

I inspected the ranked results and important snippets, not only the labels. On the original corpus, handbook and résumé lookup retain the intended files first; plumber cost, tenancy notice, gardening, exercise and monthly spending now return the right document first. Full Granite also retains the handbook PDFs at the top for the PDF filter. The title snippets make these results easier to recognize.

The validation set improved after reducing the name boost: “home office allowance” now returns the employee handbook rather than home-insurance paperwork, and “tenant moving out notice” returns the tenancy agreement. The audit exposed a tax-return/equipment-return confusion; a small body-word contribution repairs it. Both exact booking and library-card identifiers still work.

One remaining regression: “doctor note after sickness” puts the employee handbook fifth with complete Granite, versus first at PR head. The ensemble still favors unrelated medical/school passages. The audit's complete-Granite score consequently remains slightly below PR head despite the larger gains on the other sets. I kept this limitation visible rather than restoring unconditional keyword priority, which would undo the natural-language gains.

Parameter sweeps used the initial 40 questions and cached real-model scores. The separate validation set informed a smaller name boost; the fresh audit then informed one bounded lexical repair. These are development benchmarks, not untouched generalization estimates. Corpus labels were corrected so beef lasagna is not graded as a vegetarian answer. The old “noise” metric is omitted because it counted relevant handbooks and manuals as noise. No embedding speed claim is made.

The compact source-backed results and top-five lists are in [semantic-ranking.json](benchmarks/semantic-ranking.json).

## Reproduce

Install the pinned models and build the native helper, then run:

```sh
bun scripts/semantic-eval.ts --stage=all --pdf-dir="$HOME/Downloads" --json=tuning.json --verbose
bun scripts/semantic-eval.ts --stage=all --pdf-dir="$HOME/Downloads" --holdout --json=validation.json --verbose
bun scripts/semantic-eval.ts --stage=all --pdf-dir="$HOME/Downloads" --audit --json=audit.json --verbose
```

`--pdf-dir` optionally copies `ACT-UserHandbook.pdf` and `SHS Handbook 26-27.pdf` into the temporary corpus; related questions are omitted if those files are missing. `--stage=words` needs no model, `--stage=potion` uses Potion, and `--stage=full` evaluates the complete ensemble. `--tool=PATH` selects the helper; `ZSEARCH_MODELS` can select a directory holding the model files. `--word-vectors=FILE` is explicitly labeled as a stand-in. The evaluator uses isolated data without changing HOME, restores its data environment and cleans up helpers and temporary files.

Validation: full suite 315 passed, 9 skipped, zero failures with native filesystem access; final semantic regression checks (38 passed) and typecheck passed. New checks cover complete/current snapshots, partial-Granite query suppression, single-model recall in the ensemble, finite lookup scoring and document-heading snippets.
