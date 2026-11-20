# HANDOFF: SEO for calichess.cc (2026-11-20)

Done (d16f4223, deployed c9e45a3f.calichess.pages.dev -> calichess.cc): / is English, /es/ Spanish, one URL per language with hreflang (lang.js removed).
37 indexable URLs (was 10): 2 homes, 6 guides, 2 guide indexes, 2 opening hubs, 24 opening pages (/guides/en/openings/, /guides/es/aperturas/), notebook.
Opening pages: copy in site/openings/content.json, engine numbers in engine.json (site/openings/engine.cjs, 10 M nodes, needs chess.js via NODE_PATH).
App: /#fen=<FEN> opens a position (app.ts); workers resolve from import.meta.url so /es/ works. E2E: /es/#fen= Italian loads in 291 ms, recommends 3...Cf6.
JSON-LD: WebSite, WebApplication per language, BreadcrumbList, FAQPage, TechArticle. Sitemap lastmod from git. IndexNow key in build.mjs; 37 URLs sent (HTTP 202).
This deploy also published the pending OpSec fixes (0 /Users/ in the live WASM, security headers).
Lighthouse SEO 100 before and after; accessibility 82 (app: aria roles, contrast), unchanged and out of scope.
PENDING OWNER: Search Console is already verified by DNS; submit https://calichess.cc/sitemap.xml there and import the site into Bing Webmaster Tools (both need his login).
Known: an opening deep link with Black to move keeps "Juegas con Blancas"; the analysis is still for the side to move.
Not pushed: the public repo only accepts pushes built on d6295dfb (see the git history of this file).
