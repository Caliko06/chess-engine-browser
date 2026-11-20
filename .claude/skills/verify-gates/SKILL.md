---
name: verify-gates
description: Select and run this repo's scope-aware validation matrix, including focused checks, final gates, conditional oracle/bench, evidence replay, and honest failure reporting. Use before declaring a repo change done or whenever asked to "verify" or "run the gates".
user-invokable: true
---

Select validation from the actual changed surface and produce an honest verdict. An
unrun, interrupted, stale, or omitted check is NOT RUN, never PASS.

## Steps

1. **Scope first.** Run `git status --porcelain`, `git diff --stat`, and the cached forms
   when staged. Select exactly one primary row, then add its conditional evidence:

   | Changed surface | Iteration / phase evidence | Conditional evidence |
   |---|---|---|
   | Nothing; read-only audit/status | No gates; `NOT RUN — no repo state changed` | Diagnostic only when the question needs live output |
   | Docs only, not executable config | `git diff --check` plus packet-named link/marker checks | No `just test`; no `just check` unless gate doctrine itself changes |
   | `apps/web/**` | Web typecheck, lint, tests, and relevant rendered-behavior proof | Build/preview only for output or visual behavior changes |
   | One ordinary Rust crate | Format plus crate-targeted clippy and nextest | `just oracle` for board/search; `just bench` only for eval/search heuristics |
   | Search aggressive-gate/eval semantics | Search-focused tests plus soundness brackets | Assertion-bearing F3, oracle, and bench as applicable; manual F3 only when named |
   | Harness/policy/Justfile/config | Exact harness self-tests plus `just check` | Full `just test` only at final code close |

2. **Owner checkpoint first.** Classify whether the work is substantial, sequence-sensitive,
   ambiguous, or expensive to undo. When any trigger applies, record concrete working-result/Mermaid
   evidence and the authorization basis in `docs/owner-checkpoints.md`. A direct Owner instruction
   that explicitly defines the intended outcome and constraints is already authorization; record
   `OWNER_INSTRUCTION` and continue inside that boundary. Ask and stop only when a material choice
   is missing, ambiguous, rejected, or would change the stated intent or constraints. A vague plan
   or intended result is `NOT_YET`.

3. **Assess the foundation before extending.** When the change builds on an existing
   implementation, abstraction, process, or evidence path, require `FOUNDATION_ASSESSMENT` in the
   packet. Do not extend `INVALID`, `STRUCTURALLY_UNSOUND`, or `UNNECESSARILY_COMPLEX` work. Fix
   the root cause, replace it, or remove the superseded path only inside the declared fence; an
   unknown or out-of-fence remedy is `NOT_YET`. Run `just audit-owner-checkpoints --packet
   <record-path>` before the next layer. Sunk cost and fear of changing existing work are not
   reasons to retain a flawed path.

4. **Apply ADR-0213 when present.** If the changed work alters mathematical semantics, read the
   governing mathematical contract, list each selected verifier and the failure mode it detects,
   and report missing material obligations as `NOT_YET`. Do not invent a specification, treat
   second-agent agreement as evidence, or select unrelated broad gates.

5. **Run only the selected row.** A phase commit needs scoped acceptance, not automatic
   workspace tests. Code/harness packets run exactly one final `just check` and one final
   `just test` after the last validation-bearing change; docs-only packets run neither.
   Tool tests not wired into `just test` run directly when their tool changes.

6. **Apply conditional gates.** Board/search changes require `just oracle`; eval/search
   heuristic changes require `just bench` with nodes/sec delta against
   `/benches/baseline.json`. Unimplemented harness output is non-validation. Run
   `just f3-corpus-measure` only when the packet explicitly selects the ADR-0164 sweep.

7. **Respect evidence identity.** Do not repeat a green command merely because a phase
   boundary was crossed. Reuse only after `validation-evidence verify` accepts the exact
   argv and fingerprint. Deterministic decision-bearing measurements require a
   packet-declared `replay` command and ceiling.

8. **Revalidate milestones.** At each meaningful implementation milestone, record what actually
   exists and compare behavior and sequence with the Owner-defined direction before building the
   next layer. A matching milestone may cite `OWNER_INSTRUCTION` without another approval request.
   Run `just audit-owner-checkpoints --packet <record-path>`; stop on drift, missing evidence, or a
   newly unresolved material Owner decision.

9. **Handle duration honestly.** Once the matrix legitimately selects a long command,
   let it reach natural completion unless its declared ceiling or stop rule fires.
   Slowness does not justify interruption; `do not interrupt` does not justify selecting
   an irrelevant command.

10. **Handle failures by scope.** Fix failures inside the approved fence. Outside-fence
   fixes require a packet-specific mechanical, behavior-preserving remedy with named
   classes and an exact cap. Otherwise preserve the verbatim failure and close the phase
   FAIL/NOT_YET; never silently widen scope or call it PASS. If a failure invalidates the current
   foundation, stop extending it and update the root-cause/replacement/removal evidence before
   proceeding.

11. **Verdict.** Report exactly:
   - Per gate: PASS / FAIL (with the failing output tail, verbatim) / NOT RUN — reason.
   - What was fixed along the way, if anything.
   - Never summarize a red run as "mostly green". Never report a gate you did not run.

## Anti-patterns

- Selecting `just check` or `just test` solely because a phase ended.
- Interrupting a legitimately selected long test before its declared ceiling.
- Replaying `corpus_measurement_report` through the ordinary debug functional suite.
- Claiming evidence reuse from a hand-written hash or mismatched fingerprint.
- Treating a flaky-looking failure as noise: in this repo gates are deterministic;
  investigate, don't re-roll.
