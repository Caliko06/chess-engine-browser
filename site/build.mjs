// Builds the public site for https://calichess.cc into target/site:
// the app from `just preview` (Stockfish analyzer hidden, language from the browser, search tags)
// plus the guides in site/guides/{en,es}, a sitemap and robots.txt. Deploy: `just site-deploy`.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const site = dirname(fileURLToPath(import.meta.url));
const repo = dirname(site);
const out = join(repo, "target/site");
const ORIGIN = "https://calichess.cc";
const REPO_URL = "https://github.com/Caliko06/chess-engine-browser";
const today = new Date().toISOString().slice(0, 10);

if (!process.argv.includes("--skip-app")) {
  const r = spawnSync("node", ["scripts/preview-beta-0-1.mjs", "--build-only"], { cwd: repo, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
rmSync(out, { recursive: true, force: true });
cpSync(join(repo, "target/preview"), out, { recursive: true });
// Drop what the public page never loads: the only reachable piece set is the default
// (app.ts defaultPlayPieceSet); smoke.js, type declarations and the non-embedded wasm loader are unused.
for (const unused of ["assets/board", "assets/pieces/adr-0108", "assets/pieces/adr-0137", "dist/smoke.js", "dist/pkg/chess_wasm_bridge.js", "dist/pkg/chess_wasm_bridge.d.ts", "dist/pkg/chess_wasm_bridge_bg.wasm.d.ts"]) {
  rmSync(join(out, unused), { recursive: true, force: true });
}
cpSync(join(site, "static"), out, { recursive: true });
mkdirSync(join(out, "img"), { recursive: true });
for (const f of ["explore-dark.webp", "explore-light.webp", "explore-mate.webp", "explore-fork.webp", "elo-gains-light.png", "elo-gains-dark.png"]) {
  cpSync(join(repo, "docs/media", f), join(out, "img", f));
}
cpSync(join(repo, "docs/explore.png"), join(out, "img/explore.png"));
mkdirSync(join(out, "img/reconciliaciones"), { recursive: true });
for (const f of ["hero.png", "diptych.png"]) {
  cpSync(join(repo, "docs/media/reconciliaciones", f), join(out, "img/reconciliaciones", f));
}

// Cuaderno de Reconciliaciones: interactive technical + ELI5 editorial notebook with procedural JS Canvas brushstrokes.
const notebookDir = join(out, "cuaderno-de-reconciliaciones");
mkdirSync(notebookDir, { recursive: true });
let notebookHtml = readFileSync(join(repo, "docs/reconciliaciones-angelmiranda.html"), "utf8");
notebookHtml = notebookHtml
  .replaceAll("./media/reconciliaciones/", "/img/reconciliaciones/")
  .replaceAll("./media/", "/img/")
  .replaceAll("./explore.png", "/img/explore.png")
  .replace(
    "</head>",
    `<link rel="canonical" href="${ORIGIN}/cuaderno-de-reconciliaciones/">\n<link rel="icon" href="/icon-32.png" sizes="32x32" type="image/png">\n<meta property="og:title" content="Cuaderno de Reconciliaciones — CaliChess">\n<meta property="og:image" content="${ORIGIN}/img/reconciliaciones/hero.png">\n</head>`
  )
  .replace(
    '<div class="brand">',
    '<a class="pill-btn" href="/" style="text-decoration:none;margin-right:0.5rem;">← Motor</a>\n        <div class="brand">'
  );
writeFileSync(join(notebookDir, "index.html"), notebookHtml);

// Guides: each fragment starts with <!--{json meta}-->; pairs share a "pair" key.
const guides = [];
for (const lang of ["en", "es"]) {
  for (const file of readdirSync(join(site, "guides", lang)).filter((f) => f.endsWith(".html"))) {
    const text = readFileSync(join(site, "guides", lang, file), "utf8");
    const m = text.match(/^<!--(\{[\s\S]*?\})-->\n/);
    if (!m) throw new Error(`${lang}/${file}: missing meta comment`);
    guides.push({ ...JSON.parse(m[1]), lang, slug: file.replace(/\.html$/, ""), body: text.slice(m[0].length) });
  }
}
const url = (g) => `${ORIGIN}/guides/${g.lang}/${g.slug}`;
const twin = (g) => guides.find((o) => o.pair === g.pair && o.lang !== g.lang);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const T = {
  en: { open: "Open the engine", guides: "Guides", other: "Español", repo: "Source code", more: "More guides", home: "Chess engine in your browser", updated: "Updated", locale: "en_US" },
  es: { open: "Abrir el motor", guides: "Guías", other: "English", repo: "Código fuente", more: "Más guías", home: "Motor de ajedrez en tu navegador", updated: "Actualizado", locale: "es_MX" }
};

function head({ lang, title, description, canonical, alternates, image = `${ORIGIN}/og.png`, jsonld, type = "article" }) {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
${alternates.map(([l, h]) => `<link rel="alternate" hreflang="${l}" href="${h}">`).join("\n")}
<meta name="robots" content="index, follow, max-image-preview:large">
<meta name="color-scheme" content="light dark">
<meta property="og:type" content="${type}">
<meta property="og:site_name" content="CaliChess">
<meta property="og:url" content="${canonical}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:locale" content="${T[lang].locale}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${image}">
<link rel="icon" href="/icon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/icon-180.png">
<link rel="stylesheet" href="/guides/guides.css">
<script type="application/ld+json">${JSON.stringify(jsonld)}</script>
</head>`;
}

function chrome(lang, otherHref, body) {
  const t = T[lang];
  return `<body>
<header class="top"><a class="brand" href="/guides/${lang}/"><span class="logo">♞</span> CaliChess <span class="muted">${t.guides}</span></a>
<nav><a href="${otherHref}" hreflang="${lang === "en" ? "es" : "en"}">${t.other}</a><a class="cta" href="/">${t.open} →</a></nav></header>
<main class="page">
${body}
</main>
<footer class="foot"><a href="/">${t.home}</a> · <a href="/guides/${lang}/">${t.guides}</a> · <a href="${REPO_URL}">${t.repo}</a> · MIT</footer>
</body>
</html>
`;
}

for (const g of guides) {
  const tw = twin(g);
  const others = guides.filter((o) => o.lang === g.lang && o !== g);
  const jsonld = [
    { "@context": "https://schema.org", "@type": "TechArticle", headline: g.title, description: g.description, inLanguage: g.lang, datePublished: g.date, dateModified: g.date, image: `${ORIGIN}/og.png`, author: { "@type": "Person", name: "Caliko06", url: "https://github.com/Caliko06" }, mainEntityOfPage: url(g) },
    ...(g.faq ? [{ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: g.faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) }] : [])
  ];
  const faq = g.faq ? `<section class="faq"><h2>${g.lang === "en" ? "Questions" : "Preguntas"}</h2>${g.faq.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join("")}</section>` : "";
  const body = `<article>
<p class="kicker">${T[g.lang].guides} · <time datetime="${g.date}">${g.date}</time></p>
<h1>${g.h1 ?? g.title}</h1>
${g.body}
${faq}
<p class="cta-row"><a class="cta big" href="/">${T[g.lang].open} →</a></p>
<nav class="more"><h2>${T[g.lang].more}</h2><ul>${others.map((o) => `<li><a href="/guides/${o.lang}/${o.slug}">${o.title}</a></li>`).join("")}</ul></nav>
</article>`;
  const html = head({ lang: g.lang, title: g.title, description: g.description, canonical: url(g), alternates: [[g.lang, url(g)], ...(tw ? [[tw.lang, url(tw)]] : []), ["x-default", url(g.lang === "en" ? g : tw ?? g)]], jsonld }) + "\n" + chrome(g.lang, tw ? `/guides/${tw.lang}/${tw.slug}` : `/guides/${g.lang === "en" ? "es" : "en"}/`, body);
  mkdirSync(join(out, "guides", g.lang), { recursive: true });
  writeFileSync(join(out, "guides", g.lang, `${g.slug}.html`), html);
}

const indexMeta = {
  en: { title: "Chess engine guides: find the best move, learn how engines think", description: "Plain-language guides to CaliChess, a free chess engine that runs in your browser: find the best move, how a chess engine works, and how a 3000 Elo engine was built in Rust." },
  es: { title: "Guías del motor de ajedrez: encuentra la mejor jugada y aprende cómo piensa un motor", description: "Guías en lenguaje sencillo de CaliChess, un motor de ajedrez gratis que corre en tu navegador: la mejor jugada, cómo funciona un motor y cómo se hizo uno de 3000 Elo en Rust." }
};
for (const lang of ["en", "es"]) {
  const list = guides.filter((g) => g.lang === lang).sort((a, b) => a.order - b.order);
  const canonical = `${ORIGIN}/guides/${lang}/`;
  const notebookCard =
    lang === "es"
      ? `<li><a href="/cuaderno-de-reconciliaciones/"><b>Cuaderno de Reconciliaciones (Técnico + ELI5)</b><span>Ensayo interactivo con pinceladas procedurales en Canvas 2D sobre costos hundidos, errores tragados, foundations y máquinas de estado.</span></a></li>`
      : `<li><a href="/cuaderno-de-reconciliaciones/"><b>Reconciliation Notebook (Technical + ELI5)</b><span>Interactive essay with procedural Canvas 2D brushstroke illustrations on sunk costs, swallowed errors, broken foundations, and state machines.</span></a></li>`;
  const body = `<h1>${T[lang].guides}</h1><p class="lede">${indexMeta[lang].description}</p>
<ul class="cards">${notebookCard}${list.map((g) => `<li><a href="/guides/${lang}/${g.slug}"><b>${g.title}</b><span>${g.description}</span></a></li>`).join("")}</ul>`;
  const html = head({ lang, title: indexMeta[lang].title, description: indexMeta[lang].description, canonical, type: "website", alternates: [["en", `${ORIGIN}/guides/en/`], ["es", `${ORIGIN}/guides/es/`], ["x-default", `${ORIGIN}/guides/en/`]], jsonld: { "@context": "https://schema.org", "@type": "CollectionPage", name: indexMeta[lang].title, inLanguage: lang, url: canonical } }) + "\n" + chrome(lang, `/guides/${lang === "en" ? "es" : "en"}/`, body);
  writeFileSync(join(out, "guides", lang, "index.html"), html);
}

// The app page: search tags, browser language, footer with the guides, Stockfish analyzer hidden.
const indexPath = join(out, "index.html");
let app = readFileSync(indexPath, "utf8");
const swap = (from, to) => {
  if (!app.includes(from)) throw new Error(`index.html: "${from}" not found`);
  app = app.replace(from, to);
};
swap('<html lang="es">', '<html lang="en">');
// OWNER 2026-11-20: calichess.cc counts visits with Cloudflare Web Analytics (beacon injected by Cloudflare).
swap("script-src 'self' 'wasm-unsafe-eval';", "script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com;");
swap("connect-src 'self'", "connect-src 'self' https://cloudflareinsights.com");
swap("<title>Chess</title>", readFileSync(join(site, "app-head.html"), "utf8").trim());
swap('<link rel="stylesheet" href="./play.css">', '<link rel="stylesheet" href="./play.css">\n    <link rel="stylesheet" href="./site.css">');
swap('<script type="module" src="./dist/play-build-sha.js">', '<script type="module" src="./lang.js"></script>\n    <script type="module" src="./dist/play-build-sha.js">');
swap("</main>", "</main>\n" + readFileSync(join(site, "app-footer.html"), "utf8").trim());
writeFileSync(indexPath, app);

const pages = [`${ORIGIN}/`, `${ORIGIN}/cuaderno-de-reconciliaciones/`, `${ORIGIN}/guides/en/`, `${ORIGIN}/guides/es/`, ...guides.map(url)];
writeFileSync(join(out, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((p) => `  <url><loc>${p}</loc><lastmod>${today}</lastmod></url>`).join("\n")}
</urlset>
`);
for (const leftover of ["smoke-evidence", "smoke-game-archive", "smoke-analyzer"]) {
  if (existsSync(join(out, leftover))) rmSync(join(out, leftover), { recursive: true });
}
console.log(`site: ${pages.length} pages in ${out}`);
