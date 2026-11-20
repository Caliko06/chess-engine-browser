# HANDOFF: OpSec and a clean public repo (2026-11-20)

Done: the public repo Caliko06/chess-engine-browser was recreated from ONE clean commit, `d6295dfb` (an orphan with the tree of `c65eda37`, author noreply). Fresh clone: 1 ref, 1 commit, 0 personal strings; gitleaks only flags `positionKey` (Zobrist keys, false positive).
The old repo, with its 1,895 commits, PRs #1-3 and personal data in the history (username/Mac, /Users paths, a surname, a tailnet IP, a gmail), is now PRIVATE as `Caliko06/chess-engine-browser-history-private`. Full backup: `~/Backups/chess-engine-browser-2026-11-20/` (mirror, PR JSON, metadata).
LOCAL history is still the old one. `.git/hooks/pre-push` refuses any push not built on `d6295dfb`. To move work over: `git rebase --onto origin/main <old-base> <branch>` (e.g. base `c65eda37`).
`c65eda37`: the WASM build uses `--remap-path-prefix=$HOME=~` (the live WASM leaked `/Users/<user>/.cargo`); `site/static/_headers` adds HSTS, frame-ancestors, X-Frame-Options, Permissions-Policy, COOP. Verified in a separate build: 0 `/Users/` in the WASM.
PENDING: redeploy calichess.cc (`just site-deploy`) so those fixes go live. Not yet published: the OWNER chose to wait. chess-02 says nothing of theirs blocks it; the dirty tree (55 files) has an unknown owner. Option: build from a clean worktree of `c65eda37`.
PENDING OWNER: move chess-02's engine commits (codex/repo-local-preview, 9f57938..87bd5e8) onto `d6295dfb`; the GitHub social preview (`docs/media/social-preview.png`) has to be uploaded again by hand.
Note: the case study cites hashes from the old history and a compare link to github.com/Caliko06/chess that is now 404.
