# Golden eval cases (M23)

Real test designs from real tickets, scored by `manso eval` as a **release
gate** (wired into `.github/workflows/ci.yml`). Structural quality is scored
deterministically; when a case carries a *human reference*, the design's
**semantic recall** against it is measured and gated too.

```
manso eval --cases eval/cases            # gate: mean ≥ 80, floor ≥ 60, recall ≥ 60%
manso eval --cases eval/cases --min-recall 70
```

## Case format

| File | What it is |
|---|---|
| `<name>.json` | A `TestDesignPack` produced by a real run (copy `out/<KEY>/test-design.json`). |
| `<name>.reference.json` | *Optional.* The **human-written** test list for the same ticket — e.g. a QA's scenario table from a Jira comment. `{"source": "...", "notes": "...", "threshold": 0.45, "cases": [{"title": "..."}]}` |

Recall = fraction of reference cases matched by a design scenario
(deterministic token matching: stemming + corpus stopwords + blended
containment/Dice similarity, greedy 1:1, threshold 0.45 by default). Design
scenarios **beyond** the reference are reported but never penalized — designing
past the human floor is intended behaviour (M22).

## How to add a case

1. Run a design on a ticket where a human also wrote test cases.
2. Copy `out/<KEY>/test-design.json` → `eval/cases/<KEY>.json`.
3. Put the human test list into `eval/cases/<KEY>.reference.json` (one `title`
   per test case, verbatim from the QA's table/document; note the `source`).
4. Run `manso eval --cases eval/cases` locally; sanity-check the matched
   pairs and pin the expected recall in the `notes`.

## Current cases

No `TestDesignPack` cases are currently checked in. CI and releases skip the
golden-case gate when this directory has no `*.json` pack files; add a pack and
its optional reference file to enable it.
