# Semantic search on public benchmarks

The authored sets in [semantic-ranking.md](semantic-ranking.md) are small (75 queries), near their ceiling, and were used while tuning, so they cannot say much about files zsearch has never seen. This page measures semantic search on public retrieval benchmarks instead: 26 sets, short abstracts to 32,000-token documents, about 9,200 queries. It also records searches made by hand, since benchmarks reward only what their judges labeled. Everything here was measured on 2026-10-16 on an Apple-silicon MacBook with the pinned Granite model (`granite-embedding-small-english-r2`, Q8_0 GGUF, llama.cpp helper, CLS pooling).

## How

`scripts/bench-data.ts` downloads each set into `~/Library/Caches/zsearch-bench` (250 MB for all of them; nothing is committed). `scripts/semantic-bench.ts` turns every document into a file in a fresh home folder, named by its title when the set has titles (as people name saved papers and mail) and by its id otherwise, indexes the folder with zsearch's own indexer, reads it with Granite, and runs every query through the same search the app uses. EnronQA's mails are saved as `.eml`, everything else as `.txt`.

Scores are nDCG@10 (the main one), MRR@10 and recall@100, over the queries with judged documents; up to 100 hits are kept. A difference is called real only when `scripts/bench-compare.ts`'s paired bootstrap 95% interval (4,000 resamples of the queries) leaves out zero.

Each run scores several pipelines over the same index and vectors:

| Pipeline | What it is |
| --- | --- |
| words | words only, as the semantic tab shows them before Granite has finished |
| model | Granite alone: each file's best passage, no words, names, gate or discounts |
| previous | zsearch's ranking before this change |
| current | zsearch's ranking now |

Others (BM25 order, rank fusion, DigUp's ranking, no name boost, no discounts) are described at the top of `scripts/semantic-bench.ts`.

Sets:

- **BEIR** (full): SciFact, NFCorpus, ArguAna, SCIDOCS, FiQA-2018, and CQADupStack Gaming (forum questions, the one set fetched after the ranking was chosen).
- **NanoBEIR**: all 13 sets (50 queries each over 2,000 to 5,000 documents): ArguAna, ClimateFEVER, DBpedia, FEVER, FiQA-2018, HotpotQA, MS MARCO, NFCorpus, NQ, Quora, SCIDOCS, SciFact, Touché-2020.
- **LongEmbed**: 2WikiMultihopQA, QMSum, SummScreenFD, and needle retrieval at 4,096, 16,384 and 32,768 tokens. These are long files, closer to reports, transcripts and books than BEIR's abstracts.
- **EnronQA**: the 4,891 mails of one Enron mailbox (`dasovich-j`), 1,000 of its questions. Real personal files, the kind zsearch is for. Its license is unclear, so it is only downloaded, never redistributed.

## The runtime matches the model's published scores

MTEB publishes Granite small's scores with full precision, each document embedded whole. `scripts/bench-model.ts` does the same through zsearch's helper, to check that the 8-bit model, llama.cpp and CLS pooling lose nothing:

| Set | MTEB | zsearch's helper, whole documents | Cut into zsearch's passages |
| --- | ---: | ---: | ---: |
| SciFact | 0.755 | 0.757 | 0.745 |
| Needle, 4,096 tokens | 0.779 | 0.780 | |

They match. Cutting short documents into passages costs a little (SciFact 0.745); on long documents passages are what make the model usable at all (below).

## zsearch against the model alone

nDCG@10, before this change's ranking (it does not change the model or words columns):

| Set | Words | Model alone | MTEB | zsearch |
| --- | ---: | ---: | ---: | ---: |
| SciFact | 0.612 | 0.750 | 0.755 | 0.764 |
| NFCorpus | 0.292 | 0.363 | 0.371 | 0.377 |
| ArguAna | 0.278 | 0.580 | 0.544 | 0.587 |
| SCIDOCS | 0.133 | 0.236 | 0.241 | 0.227 |
| FiQA-2018 | 0.147 | 0.392 | 0.408 | 0.402 |
| CQADupStack Gaming | 0.442 | 0.604 | 0.624 | 0.603 |
| 2WikiMultihopQA | 0.915 | 0.969 | 0.800 | 0.978 |
| SummScreenFD | 0.960 | 0.889 | 0.899 | 0.918 |
| QMSum | 0.805 | 0.573 | 0.365 | 0.694 |
| Needle, 4,096 tokens | 0.975 | 0.693 | 0.779 | 0.811 |
| Needle, 16,384 tokens | 0.970 | 0.775 | 0.442 | 0.861 |
| Needle, 32,768 tokens | 0.978 | 0.733 | 0.219 | 0.859 |
| EnronQA | 0.765 | 0.599 | | 0.618 |
| NanoBEIR, mean of 13 | 0.512 | 0.629 | | 0.635 |

- On short documents, zsearch's ranking is the model's score within about ±0.02, a little above on most sets. SCIDOCS (titles of cited papers as queries) is the one set where the filename boost hurts: without it zsearch gets 0.233.
- On long documents, passages lift the model far above MTEB's whole-document score (needle at 32,768 tokens: 0.73 against 0.22), because the model reads only the first 8,192 tokens and blurs everything into one vector.
- Words alone beat the old ranking on EnronQA, QMSum, SummScreenFD and the needles. Their questions repeat rare words of the answer (names, places, subjects), and the Granite stage counted every query word the same: matching "meeting" counted as much as matching "Dasovich". This change narrows that gap.

## What changed: rare words count for more with vectors too

Words-only ranking already weighted each query word by its IDF (how rare it is among the indexed files). With vectors it counted the share of query words a file holds, at weight 0.5. Now the Granite stage uses the same IDF-weighted share, at weight 1.5 (`RANKING.coverage`, `RANKING.idf` in `src/semantic/search.ts`). Code and number lookups still count every word the same, as before.

The weight was chosen on development sets, comparing 1, 1.5 and 2. 2 was best on EnronQA but significantly worse on NanoArguAna (−0.027 [−0.058, −0.002]), where queries are whole arguments and their words say little; 1.5 is the largest weight without a significant loss there.

Development sets (used to choose 1.5):

| Set | Queries | Previous | Current | Difference [95% interval] |
| --- | ---: | ---: | ---: | --- |
| EnronQA | 1,000 | 0.618 | 0.724 | **+0.105** [+0.091, +0.118] |
| QMSum | 1,527 | 0.694 | 0.810 | **+0.116** [+0.104, +0.128] |
| NanoDBpedia | 50 | 0.578 | 0.621 | **+0.043** [+0.017, +0.075] |
| NanoMS MARCO | 50 | 0.599 | 0.642 | +0.043 [−0.003, +0.089] |
| NanoNQ | 50 | 0.701 | 0.712 | +0.011 [−0.032, +0.056] |
| NanoClimateFEVER | 50 | 0.331 | 0.339 | +0.008 [−0.019, +0.032] |
| NanoSciFact | 50 | 0.805 | 0.806 | +0.000 [−0.027, +0.028] |
| NanoArguAna | 50 | 0.710 | 0.695 | −0.015 [−0.038, +0.002] |

Confirmation sets (not used to choose):

| Set | Queries | Previous | Current | Difference [95% interval] |
| --- | ---: | ---: | ---: | --- |
| CQADupStack Gaming, fetched after the choice | 1,595 | 0.603 | 0.614 | **+0.010** [+0.004, +0.016] |
| FiQA-2018 | 648 | 0.402 | 0.410 | +0.008 [−0.001, +0.018] |
| NFCorpus | 323 | 0.376 | 0.382 | +0.006 [−0.002, +0.013] |
| ArguAna | 1,401 | 0.587 | 0.583 | −0.003 [−0.007, +0.000] |
| SCIDOCS | 1,000 | 0.227 | 0.223 | **−0.004** [−0.008, −0.001] |
| NanoTouché-2020 | 49 | 0.518 | 0.598 | **+0.079** [+0.050, +0.111] |
| NanoQuora | 50 | 0.923 | 0.932 | +0.008 [−0.007, +0.030] |
| NanoFEVER | 50 | 0.938 | 0.938 | +0.000 [−0.002, +0.002] |
| NanoNFCorpus | 50 | 0.374 | 0.362 | −0.012 [−0.042, +0.011] |
| NanoSCIDOCS | 50 | 0.441 | 0.421 | **−0.020** [−0.038, −0.004] |

CQADupStack Gaming (gaming forum questions, 45,301 posts; MTEB 0.624, Granite alone through zsearch 0.604, words only 0.442) was not looked at until the weight was fixed, so it is the cleanest test here: a small, real gain.

Authored sets (`scripts/semantic-eval.ts --stage=all --packages=20`):

| Set | Queries | Previous | Current |
| --- | ---: | ---: | ---: |
| Tuning | 37 | 0.913 | 0.925 |
| Validation | 18 | 0.927 | 0.938 |
| Audit | 20 | 0.973 | 0.991 |

Search takes as long as before: the weights come from word-match counts the search already has.

Six more sets were measured only at weight 1, not rerun at 1.5 (the run stopped when the Mac went on battery); at weight 1 none got worse: SciFact +0.000, NanoHotpotQA +0.017, NanoFiQA +0.038, 2WikiMultihopQA +0.011, needle at 16,384 tokens +0.043, SummScreenFD +0.017.

The cost is SCIDOCS-like queries, whose words are common in the field (NanoSCIDOCS −0.020, SCIDOCS −0.004, both significant). The gains are where people search their own files with words from the answer: mail, transcripts, long documents.

## Searches by hand

Benchmarks reward whatever their judges labeled, so the change was also looked at by hand. A folder like a person's home (the 49 authored notes, 1,500 of the Enron mails, 40 QMSum meeting transcripts, zsearch's docs, and 203 package READMEs, licenses and changelogs) got 36 searches written before seeing any results: everyday questions, one-word searches, mail topics, transcripts and technical docs. Each search's top 5 under the previous and the current ranking were compared side by side.

- The top hit is the same for 32 of the 36; 9 have the same top 5. The change moves ranks 2 to 5.
- Better: *transcript where the committee discussed school funding* (before, five unrelated mails; now the two education-committee transcripts first), *PG&E bankruptcy* (mails that mention the bankruptcy move up), *passport* (the offsite mail that asks people to bring passports replaces a package license), *meeting about the budget for the remote control* (a budget mail gives way to another design meeting), *emails about the California rate freeze* (a brief arguing when the rate freeze ends comes first).
- Worse: *job application* (mails about a FERC application and an "application matrix" push out a résumé workshop), *complaints about Enron's role in the blackouts* (a pipeline complaint comes second), *breaking changes in the new version* (the user's own project changelog, which never says "breaking", drops out for package changelogs that do).
- Wrong either way: *notes on my thesis* puts the thesis draft 7th, behind mails named "notes"; *something vegetarian for dinner* finds dinner mails before the lentil curry that calls itself vegetarian; *lunch next week* finds nothing useful.

In everyday searches the change is a small net gain, much smaller than on EnronQA or QMSum. Its risk is one rare word used in another sense (application, complaint) pulling up files about something else. The thesis case points at the filename boost, which still counts a common word ("notes") as much as a rare one ("thesis").

## Tried and not adopted

- **Reciprocal rank fusion** of the word and meaning orders: +0.115 on EnronQA, but −0.138 on NanoNQ, −0.081 on NanoSciFact and −0.058 on SCIDOCS. Score fusion with IDF weights gets most of the gain without the losses.
- **BM25 order of word matches** in the Granite stage (`strength`): small significant gains on the long sets (QMSum +0.096, needle-16k +0.036, SummScreenFD +0.019) but 5 to 10 times slower searches (300 to 600 ms on large sets), and mixed results on top of IDF weights elsewhere (NanoFiQA +0.013, SciFact −0.012).
- **DigUp's ranking**, and dropping the length discount: better on some sets, worse on others, nothing consistent.
- **Dropping the filename boost**: helps SCIDOCS (+0.006) and NanoDBpedia (+0.027), and changes nothing elsewhere. It stays, because finding a saved file by its name (a handbook, a résumé) is what it is for, and these sets name files by paper or article titles, not as people name their own files.

## Remaining weaknesses

- **Words still beat Granite on some sets of long documents and mail**: EnronQA 0.765 against 0.724, SummScreenFD 0.960 against about 0.93, needles 0.97 against about 0.90 (QMSum is now even, 0.805 against 0.810). These queries reuse the answer's words, which plain word search is built for. A stronger mix of BM25 into the Granite stage, if it can be made fast, is the next thing to try.
- **The meaning gate empties long-document results** without word matches: the model-only part of the ranking returns nothing for 70% of QMSum queries and 22–30% of needle queries, because no passage stands far enough above the rest of a long file's passages. Word matches cover them now; a query with no matching words would get nothing. A fallback to the best few meanings when the gate passes nothing would close this.
- **" -word" in a question is read as a negation** (`a Python-like language` is fine, `a Python -like language` drops files holding "like"). Fewer than 0.5% of benchmark queries are affected.
- **The filename boost counts every word the same**, so a common word in many names ("notes") can outrank the file named for the rare one.
- NanoBEIR's 50 queries per set only show large differences; most of its rows above hold zero.

## Reproduce

```sh
bun scripts/bench-data.ts --list
bun scripts/bench-data.ts scifact nfcorpus arguana scidocs fiqa lemb-qmsum lemb-summscreenfd lemb-2wikimqa lemb-needle-16384 enron-dasovich
bun scripts/bench-data.ts nano                              # NanoBEIR, needs uv
bun scripts/semantic-bench.ts --dataset=~/Library/Caches/zsearch-bench/scifact --json=scifact.json
bun scripts/semantic-bench.ts --dataset=~/Library/Caches/zsearch-bench/enron-dasovich --queries=1000 --pipelines=words,current,previous
bun scripts/bench-compare.ts *.json --base=previous         # paired intervals
bun scripts/bench-model.ts --dataset=~/Library/Caches/zsearch-bench/scifact   # the model alone, against MTEB
```

Reading a set with Granite takes 1 to 10 minutes (FiQA, 57,638 documents, about 30). Run on mains power: a full pass over every set drains a laptop battery.
