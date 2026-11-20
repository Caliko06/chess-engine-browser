---
name: diagnose
description: Feedback-loop-first diagnosis discipline for this repo. Use when something is broken, throwing, failing, flaky, or slower than baseline — a regression in search/eval output, a WASM bridge discrepancy, a failing or flaky test, a nodes/sec drop — before proposing any cause or fix.
---

Diagnose by building a reproduction loop first, hypothesizing second, instrumenting
third. The contract of this skill mirrors ADR-0199's honesty rules: no red-capable
command, no hypothesis. Reading code to build a theory before a reproduction command
exists is the exact failure this skill prevents.

## Phase 1 — Build a red-capable loop (this is the skill)

Produce ONE command that you have already run at least once (record the invocation and
its output), and that is:

- **Red-capable** — it drives the actual failing code path and asserts the exact
  reported symptom (wrong eval, wrong move, wrong DTO field, slow timing), so it goes
  red on this bug and green once fixed. "Runs without erroring" does not qualify.
- **Deterministic** — same verdict every run. Pin seeds, positions (FEN), and node
  budgets; this repo bans wall clocks in library crates, so any nondeterminism from
  timing is itself a finding.
- **Fast** — seconds where possible. Prefer a single test over a suite:
  `just test` wraps nextest; run one test with the nextest filter the recipe uses, or
  `node --test <file>` for tool/web tests. Never wait on the full ~17-minute workspace
  pass just to reproduce.
- **Agent-runnable** — no human in the loop.

Repo-specific loop material, in rough order of preference:

1. A failing `#[test]` at the crate seam (`crates/search`, `crates/board`,
   `crates/wasm-bridge` tests) pinned to a FEN + node budget.
2. `just oracle` narrowed to the offending position set (board/search correctness).
3. `just bench` vs `benches/baseline.json` (performance regressions — measure first,
   never diagnose perf from logs).
4. A `scripts/proof-*.mjs` style driver for web/UI-visible behavior, or a scoped
   `node --test` for `apps/web` suites.
5. Differential loop: same FEN/budget through two commits, or native vs WASM — diff
   the outputs.

Flaky failures: do not chase a clean repro — raise the reproduction rate (loop the
trigger 100×, fix seeds, narrow the budget) until it fails most runs, then treat that
as the loop.

If you genuinely cannot build one, stop and say so explicitly, listing what you tried
and what artifact or access would unblock it. Do not proceed to Phase 2.

## Phase 2 — Hypothesize, falsifiably

Write 3–5 ranked hypotheses BEFORE testing any of them; a single hypothesis anchors on
the first plausible idea. Each must state its prediction: "if X is the cause, changing
Y makes the loop go green / Z makes it worse." A hypothesis without a prediction is
discarded or sharpened. Show the ranked list in the run log (or to the user when
interactive) before instrumenting — do not block on a reply.

## Phase 3 — Instrument, one variable at a time

Each probe must map to one Phase-2 prediction. Tag every temporary debug line with one
unique prefix per session, e.g. `[DEBUG-a4f2]`, so cleanup is a single grep. Never
"log everything and grep". For perf: baseline measurement, then bisect; logs lie about
time.

## Phase 4 — Fix, regression test, verify

1. Turn the minimized repro into a failing test at the correct seam — the seam where
   the real bug pattern occurs. If no correct seam exists, that absence is itself a
   finding: record it instead of writing a false-confidence test elsewhere.
2. Watch it fail, apply the fix, watch it pass.
3. Re-run the original (unminimized) Phase-1 loop.
4. Run the `verify-gates` skill before declaring done — its conditional-gate rules
   (oracle for board/search, bench for eval/search heuristics) apply to the fix.
5. Grep the `[DEBUG-...]` prefix; zero hits before commit.
6. State the confirmed hypothesis in the commit message so the next debugger inherits
   it.

Report honestly per repo doctrine: a loop never built is NOT BUILT, a hypothesis never
confirmed is a guess, and a fix whose loop was not re-run is unverified.
