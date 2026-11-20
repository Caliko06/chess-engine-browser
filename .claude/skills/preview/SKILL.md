---
name: preview
description: Build the WASM bridge and launch the local Chess preview server on a fixed loopback port, confirm it actually loaded the WASM bridge, then return the exact URL and PID with kill instructions.
user-invokable: true
---

Launch a testable local preview of the app so the user can play against the engine in a browser. This wraps `just preview` (`node scripts/preview-beta-0-1.mjs`), which rebuilds the web bundle, compiles `chess-wasm-bridge` to `wasm32-unknown-unknown`, runs `wasm-bindgen`, and serves the result — never substitute a plain static file server (e.g. `python3 -m http.server`) on `apps/web`, it will serve a page with no engine.

## Steps

1. **Pick a fixed port.** Default to `7700` (the script's own default). If it's already in use, choose another and export `CHESS_PREVIEW_PORT=<port>` for the run — don't silently fall back to a random port, the user needs a stable URL.

2. **Launch in the background, detached.** The script blocks in the foreground waiting for `SIGINT`/`SIGTERM`, so it will die if the tool session it's attached to exits or backgrounds naively. Start it fully detached and capture its PID, e.g.:
   ```bash
   nohup env CHESS_PREVIEW_PORT=7700 just preview > /tmp/chess-preview.log 2>&1 &
   disown
   echo $!
   ```
   Record the PID.

3. **Poll until the server is actually serving, don't assume readiness.** The build step (pnpm build + cargo build + wasm-bindgen) takes real time. Poll `http://127.0.0.1:<port>/index.html` (e.g. with `curl -sf`) in a loop until it returns 200, or until the log shows the "local preview" ready line. If it never comes up, read `/tmp/chess-preview.log` for the failure (most common: stale port already bound, or a build error) and fix that instead of declaring success.

4. **Confirm the WASM bridge actually loaded**, not just that some HTML came back:
   ```bash
   curl -s http://127.0.0.1:<port>/dist/pkg/chess_wasm_bridge_embedded.mjs | grep -q 'WebAssembly.Module' && echo OK
   ```
   If this doesn't match, the preview is serving stale or incomplete output — treat it as a failed launch, not a caveat.

5. **Report back**, verbatim, all three of:
   - The exact URL: `http://127.0.0.1:<port>/index.html`
   - The PID of the backgrounded process
   - The kill command: `kill <PID>` (the script traps `SIGTERM`/`SIGINT` and shuts down cleanly)

Never report a preview as ready without having polled it successfully — a URL that isn't confirmed live is not a deliverable.
