---
status: "accepted"
date: 2026-08-29
decision-makers: [hawkeyexl]
---

# Golden cases are seeded from reviews, and gated on human confirmation

## Context and Problem Statement

The judge's calibration loop does not close.

`moose-docevals review` records a human verdict for one eval on one page and persists it to `.moose-docevals/reviews.yaml` — `ReviewEntry`, `recordReview`, `REVIEWS_PATH` in `src/core/reviews.ts`, written by `runReview` in `src/commands/review.ts`. `moose-docevals calibrate` measures the judge against a human-verified golden set, read by `loadGoldenCases` from `.moose-docevals/golden/*.yaml` (`src/commands/calibrate.ts`), and on an empty directory raises `Golden set directory not found: … — create it with 20-50 human-verified cases`.

Nothing bridges the two. The tool collects, in a structured file, exactly the data its calibration step consumes — a page, an eval, a human's pass/fail — and then asks the user to re-author it by hand in a second file with three of the same four fields. Twenty to fifty hand-written cases is the single largest piece of friction between installing the tool and being able to trust its judge, and `calibrate` is the step the manuscript names as the prerequisite to trusting an LLM judge at all. The instruction to write them is where adoption stops.

A second hole sits underneath, and it is the more dangerous one. `ReviewEntry` carries a `contentHash`, and `findReview` returns `undefined` once the page body no longer hashes to it — so a review expires with the page it was about, and the eval returns to needs-review. `GoldenCase` carries no such field. A case verified against one draft keeps certifying the rewrite, silently, forever. It does that while being the artifact that certifies the judge: the instrument drifts out of calibration and reports full agreement while doing so.

## Decision Drivers

- **The data already exists in the repo.** Re-authoring `reviews.yaml` as `golden/*.yaml` by hand is transcription, and the friction is structural rather than editorial — no amount of documentation removes a manual copy step.
- **A review verdict and a golden case are not the same claim.** One is "I unblocked this build"; the other is "this is what correct looks like". Seeding must not silently promote the first into the second.
- **The golden set measures the judge, so the judge cannot assemble it** — and neither can an agent. Whatever generates the cases decides what "correct" means, which makes generation and measurement the same act.
- **A case that outlives the page it described is worse than no case**, because it reports agreement instead of absence. Reviews already solved this with `contentHash`; golden cases inherited nothing.
- **A gate that fires before the user has done anything wrong gets removed.** Whatever this change does to the agreement rate must not make the first run red.
- **`calibrate` judges one case at a time.** The bounded-concurrency pool in `makeJudge` is sized `Math.min(concurrency, targets.length)` (`src/judge/judge.ts:156`), so a one-target call pins it to 1 regardless of `defaults.concurrency` (default 4, `src/core/config.ts:383`). [ADR 01019](01019-a-turn-budget-replaces-the-cost-budget.md) deferred `--max-turns` on `calibrate` for exactly this reason: a per-invocation counter across a per-case loop reads as a run-wide cap and is not one.

## Considered Options

- **Seed from reviews, gated on an explicit `reviewed` bit.**
- **Seed from reviews, trust them as golden immediately.**
- **Generate the golden set with a `fill`-style LLM proposal pass.**
- **Keep hand-authoring, and document it better.**

## Decision Outcome

Chosen option: **seed golden cases from recorded reviews, and gate them on an explicit human confirmation bit.**

**1. `calibrate --seed` reads `reviews.yaml` and writes candidates.** It honours the existing `--golden <dir>` flag, and writes one case per review entry into a seeded file in that directory (`SEEDED_GOLDEN_FILE`). The review's `verdict` becomes the case's `expected`; the review's `contentHash` becomes the case's `content-hash`. `seedGoldenCases` judges nothing and constructs no provider — it never reaches `makeProvider`. That is a property, not an accident of the current code path: it is what lets seeding run in CI, where no API key is set, and it is asserted as such.

**2. Seeded cases land unreviewed.** The case gains four fields, kebab-case in the file per [ADR 01010](01010-kebab-case-is-the-file-vocabulary.md) and camelCase in `GoldenCase`:

```yaml
- file: docs/install.md
  eval: no-future-promises
  expected: pass
  reviewed: false
  content-hash: 3f2a…
  source: review        # review | manual
  reviewed-by: priya    # optional
```

`reviewed-by` names whoever confirmed the case as golden, and seeding deliberately does not copy it from the review's `reviewer`. Filing a verdict on a page and endorsing that verdict as ground truth are different acts, frequently minutes apart and occasionally by different people; pre-filling the field would record a confirmation nobody made, which is the whole thing this option exists to prevent.

**3. An absent `reviewed` means `false`.** A back-compatible default would silently bless every case that already exists — including the ones this change exists to make visible. The one hand-authored fixture, `test/fixtures/golden/cases.yaml`, is genuinely human-verified, so it gains `reviewed: true` explicitly in this same change rather than being rescued by a default. A case with no `content-hash` is *not* stale: it never made a claim about the body, so there is nothing to have broken. It is unverifiable until re-seeded or stamped by hand, and the unreviewed count is what surfaces it.

**4. Unreviewed and stale cases still count toward the agreement rate, and warn loudly.** They are judged, reported per case (`CalibrationCaseResult.reviewed`, `.stale`), and included in `agreementRate`, `falsePositiveRate` and `meetsThreshold`, with a per-case warning plus a summary line naming `report.unreviewed` and `report.stale`. A stale case is one whose `content-hash` no longer matches the current page body — the same test `findReview` already applies to reviews.

This is the arguable half of the decision, so the rejected alternative is worth stating in full. **Excluding** unreviewed cases from the rate would keep the headline number honest: the calibration report is the artifact handed to a skeptic, and a rate padded with rows nobody checked is arguably worse than no rate at all. It was rejected on what it does to the first run. `calibrate` exits 1 below `AGREEMENT_THRESHOLD` (0.7), and with every seeded case excluded the counted set is empty, `agreementRate` is 0, and the very first `calibrate --seed` produces a red build — at the exact moment a user is trying to get started, over cases the tool itself just wrote. A gate that fires before anyone has done anything wrong gets removed, and then it protects nothing. Counting-with-a-warning keeps the loop moving and puts the judgement in the reader's hands. This trades headline precision for adoption, deliberately.

**5. `calibrate` batches its cases into one judge call.** It called the judge once per case in a loop, which had two consequences: the concurrency pool never had more than one target to work with (`src/judge/judge.ts:65`, `:156`), and the turn counter — which lives inside a single judge invocation — would have made a `--max-turns` on this command silently mean *per case*. Batching fixes both. Cases now judge concurrently under `defaults.concurrency`, and `calibrate` gains `--max-turns` with the same run-wide meaning it has on `run` and `fill`. This is the follow-through [ADR 01019](01019-a-turn-budget-replaces-the-cost-budget.md) explicitly deferred.

### Consequences

- **The loop closes.** The path from "the judge flagged something I disagree with" to "my golden set covers that case" is now `review` → `calibrate --seed` → flip the bit. It was: read the docs, hand-author YAML.
- **A golden set is now self-invalidating, like a review.** Edit the page and its cases report stale. That is new work for the user, and it is the correct kind — a case that no longer describes the page was already wrong, just invisibly.
- **The seeded file is a candidate list, not a golden set**, until a human has been through it, and the warning says so on every run until then. A user who ignores the warning has a calibration number built on unexamined rows; the number is not silently wrong, it is loudly provisional.
- **Seeding is idempotent on `(file, eval)`.** Re-running updates the existing case — including `expected`, when a later review reversed the verdict — rather than appending a near-duplicate, so it can be re-run as reviews accumulate. `seedGoldenCases` reports `added` and `updated` separately so the difference is visible.
- **A confirmed bit describes a verdict, not a filename.** Re-seeding preserves `reviewed: true` when the recorded verdict is unchanged, and clears it when the verdict has flipped. Carrying the bit across a flip would let `expected` change under a human's signature — the case would still read as confirmed while asserting the opposite of what was confirmed. `reviewed-by` is dropped with the bit for the same reason.
- **`calibrate` now spends turns concurrently**, so an ill-judged `--runs` on a large golden set costs more, faster than it used to. `--max-turns` is the bound, and it now means what it says.
- **Bad, and accepted**: flipping `reviewed` is an unauthenticated self-report, exactly like deleting an `eval-provenance` entry ([ADR 01011](01011-fill-writes-a-durable-provenance-trail.md)). Nothing verifies that the person who set the bit read the case. The trail records the claim; it cannot audit it.

### Confirmation

`test/unit/calibrate-golden.test.ts` pins the contract: an absent `reviewed` parses as `false`; the kebab file keys read into camelCase; an unreviewed case is counted *and* raises `report.unreviewed`; a case whose `content-hash` no longer matches the page is counted, flagged, and named separately in `report.stale`, while a matching hash flags neither; `--seed` writes one unreviewed case per review entry carrying that review's `contentHash`; re-seeding updates rather than duplicating on `(file, eval)`; `--seed` completes with `ANTHROPIC_API_KEY` unset; and `runCalibrate` invokes the injected judge exactly once for a two-case set. CI dogfoods `--seed` through the built CLI, alongside the other `node dist/cli.js` steps in [ci.yml](../.github/workflows/ci.yml), to pin the no-provider property end to end rather than only at the seam a unit test can reach.

## Pros and Cons of the Options

### Seed from reviews, gated on an explicit `reviewed` bit

- Good, because it removes a transcription step between two files the tool already owns, which is where adoption was stopping.
- Good, because the gate is one boolean a human sets, so "has anyone actually checked these?" is answerable by reading the file rather than by remembering.
- Good, because `content-hash` gives the golden set the expiry semantics reviews have had all along, closing the drift hole underneath everything else.
- Neutral, because counting unreviewed cases toward the rate is a deliberate trade: the headline number is provisional until the warning stops appearing.
- Bad, because a user who ignores the warning gets a calibration number that looks authoritative and is not.

### Seed from reviews, trust them as golden immediately

- Good, because it is the shortest path — no new fields, no bit to flip, one command and calibration runs.
- Bad, because a `review` verdict is one human's call on one page in one moment, often made to clear a queue. Promoting it to calibration ground truth without a second look conflates "I unblocked this build" with "this is what correct looks like".
- Bad, because the conflation is invisible afterwards: nothing in the resulting file distinguishes a considered case from a cleared one, so the mistake cannot be found later.

### Generate the golden set with a `fill`-style LLM proposal pass

- Good, because `fill` already has the machinery — prompt, cache, confidence, provenance — and it would scale to a large corpus with no human in the loop.
- Bad, and disqualifying: the golden set is the instrument that measures the judge. Generating it with a model is measuring a ruler against itself, and the agreement rate it produces measures nothing but the two models' shared priors.
- Bad, because a high score from such a set is actively harmful — it is the specific number a user points at to justify trusting the judge.

### Keep hand-authoring, and document it better

- Good, because every case is then unambiguously human-authored, which is the property the `reviewed` bit has to reconstruct.
- Bad, because the friction is structural, not editorial. The blocker is not that users cannot find the instructions; it is that the instructions ask for twenty to fifty hand-written records whose content is already sitting in `.moose-docevals/reviews.yaml`.
- Bad, because it leaves the staleness hole entirely unaddressed — hand-authored cases carry no `content-hash` either.
