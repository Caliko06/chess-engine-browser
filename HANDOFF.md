# HANDOFF: case study §15 "How I did it" + public main caught up (2026-11-20)

Done: docs/case-study-2026-11.md §15 rewritten in the OWNER's first person, paraphrased from his session messages and decisions (May-Oct history: 847 commits, 46% docs; 12 turns on 18-20 Nov; his 6 rules; what the agents did, Opus found see()). Strength row fixed: ~1286 Elo on 18 Nov, not "not measured".
Public main (Caliko06/chess-engine-browser) now carries everything: the local branch was rebased onto the clean root d6295dfb (old c65eda37..HEAD), so the reconciliation is 41d93d70 and the SEO block e101b616 there.
Also committed: empty smoke tests and review-dtos.test.ts removed (unknown session's dirty tree), browser proofs launch chrome-bot. `just test`: 399 Rust passed, web suites passed.
Left untracked on purpose: config.json (fastchess config with a /Users path) and .hallmark/ (local screenshots).
calichess.cc not redeployed: no site file changed since the SEO deploy (e101b616). The portfolio links to the case study on GitHub main, so it is already live there.
Then (2a2ccf14): §14 split into fixed (errors, bench, proof scripts, README) and still open (legacy lenses, Explore reply, play-ui state, Explore strength); a note explains the private-history hashes; the dead compare link now points to the public snapshot d6295dfb; the stale screenshot became docs/media/explore-dark.webp.
Local `main` and old branches are still the private history; the pre-push hook only lets commits built on d6295dfb through.
