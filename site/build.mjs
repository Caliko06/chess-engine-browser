// Builds the public site for https://calichess.cc into target/site:
// the app from `just preview` in English at / and Spanish at /es/ (Stockfish analyzer hidden, search tags,
// crawlable intro), the guides in site/guides/{en,es}, the opening pages from site/openings, a sitemap,
// robots.txt and the IndexNow key. Deploy: `just site-deploy`.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const site = dirname(fileURLToPath(import.meta.url));
const repo = dirname(site);
const out = join(repo, "target/site");
const ORIGIN = "https://calichess.cc";
const REPO_URL = "https://github.com/Caliko06/chess-engine-browser";
const INDEXNOW_KEY = "be842e91426e7132cb66dc995056b0ad";
// lastmod is the last commit that touched the page's sources, so it only moves when the page does.
const gitDate = (...paths) =>
  spawnSync("git", ["log", "-1", "--format=%cs", "--", ...paths], { cwd: repo }).stdout.toString().trim() ||
  new Date().toISOString().slice(0, 10);

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
writeFileSync(join(out, `${INDEXNOW_KEY}.txt`), INDEXNOW_KEY);
mkdirSync(join(out, "img"), { recursive: true });
for (const f of ["explore-dark.webp", "explore-light.webp", "explore-mate.webp", "explore-fork.webp", "elo-gains-light.png", "elo-gains-dark.png"]) {
  cpSync(join(repo, "docs/media", f), join(out, "img", f));
}
cpSync(join(repo, "docs/explore.png"), join(out, "img/explore.png"));
mkdirSync(join(out, "img/reconciliaciones"), { recursive: true });
for (const f of ["hero.png", "diptych.png"]) {
  cpSync(join(repo, "docs/media/reconciliaciones", f), join(out, "img/reconciliaciones", f));
}

const sitemap = [];
const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

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
    '<a class="pill-btn" href="/es/" style="text-decoration:none;margin-right:0.5rem;">← Motor</a>\n        <div class="brand">'
  );
writeFileSync(join(notebookDir, "index.html"), notebookHtml);
sitemap.push([`${ORIGIN}/cuaderno-de-reconciliaciones/`, gitDate("docs/reconciliaciones-angelmiranda.html")]);

const T = {
  en: { open: "Open the engine", guides: "Guides", openings: "Openings", other: "Español", repo: "Source code", more: "More guides", home: "Chess engine in your browser", locale: "en_US", root: "/", openingsDir: "openings", questions: "Questions" },
  es: { open: "Abrir el motor", guides: "Guías", openings: "Aperturas", other: "English", repo: "Código fuente", more: "Más guías", home: "Motor de ajedrez en tu navegador", locale: "es_MX", root: "/es/", openingsDir: "aperturas", questions: "Preguntas" }
};
const otherLang = (lang) => (lang === "en" ? "es" : "en");
const breadcrumbs = (crumbs) => ({
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: crumbs.map(([name, item], i) => ({ "@type": "ListItem", position: i + 1, name, item }))
});
const faqLd = (faq) => ({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) });
const faqHtml = (lang, faq) => `<section class="faq"><h2>${T[lang].questions}</h2>${faq.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join("")}</section>`;

// Title, description, canonical, hreflang, social cards and JSON-LD: shared by the app pages and the guides.
function meta({ lang, title, description, canonical, alternates, image = `${ORIGIN}/og.png`, jsonld, type = "article" }) {
  return `<title>${esc(title)}</title>
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
<meta property="og:locale:alternate" content="${T[otherLang(lang)].locale}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${image}">
<link rel="icon" href="/icon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/icon-180.png">
${[jsonld].flat().map((j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`).join("\n")}`;
}

function guidePage(opts, otherHref, body) {
  const { lang } = opts;
  const t = T[lang];
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${meta(opts)}
<link rel="stylesheet" href="/guides/guides.css">
</head>
<body>
<header class="top"><a class="brand" href="/guides/${lang}/"><span class="logo">♞</span> CaliChess <span class="muted">${t.guides}</span></a>
<nav><a href="${otherHref}" hreflang="${otherLang(lang)}">${t.other}</a><a class="cta" href="${t.root}">${t.open} →</a></nav></header>
<main class="page">
${body}
</main>
<footer class="foot"><a href="${t.root}">${t.home}</a> · <a href="/guides/${lang}/">${t.guides}</a> · <a href="/guides/${lang}/${t.openingsDir}/">${t.openings}</a> · <a href="${REPO_URL}">${t.repo}</a> · MIT</footer>
</body>
</html>
`;
}
const author = { "@type": "Person", name: "Caliko06", url: "https://github.com/Caliko06" };

// Guides: each fragment starts with <!--{json meta}-->; pairs share a "pair" key.
const guides = [];
for (const lang of ["en", "es"]) {
  for (const file of readdirSync(join(site, "guides", lang)).filter((f) => f.endsWith(".html"))) {
    const text = readFileSync(join(site, "guides", lang, file), "utf8");
    const m = text.match(/^<!--(\{[\s\S]*?\})-->\n/);
    if (!m) throw new Error(`${lang}/${file}: missing meta comment`);
    guides.push({ ...JSON.parse(m[1]), lang, slug: file.replace(/\.html$/, ""), body: text.slice(m[0].length), modified: gitDate(`site/guides/${lang}/${file}`) });
  }
}
const url = (g) => `${ORIGIN}/guides/${g.lang}/${g.slug}`;
const twin = (g) => guides.find((o) => o.pair === g.pair && o.lang !== g.lang);

for (const g of guides) {
  const tw = twin(g);
  const others = guides.filter((o) => o.lang === g.lang && o !== g);
  const jsonld = [
    { "@context": "https://schema.org", "@type": "TechArticle", headline: g.title, description: g.description, inLanguage: g.lang, datePublished: g.date, dateModified: g.modified, image: `${ORIGIN}/og.png`, author, mainEntityOfPage: url(g) },
    breadcrumbs([[T[g.lang].guides, `${ORIGIN}/guides/${g.lang}/`], [g.h1 ?? g.title, url(g)]]),
    ...(g.faq ? [faqLd(g.faq)] : [])
  ];
  const body = `<article>
<p class="kicker">${T[g.lang].guides} · <time datetime="${g.modified}">${g.modified}</time></p>
<h1>${g.h1 ?? g.title}</h1>
${g.body}
${g.faq ? faqHtml(g.lang, g.faq) : ""}
<p class="cta-row"><a class="cta big" href="${T[g.lang].root}">${T[g.lang].open} →</a></p>
<nav class="more"><h2>${T[g.lang].more}</h2><ul>${others.map((o) => `<li><a href="/guides/${o.lang}/${o.slug}">${o.title}</a></li>`).join("")}<li><a href="/guides/${g.lang}/${T[g.lang].openingsDir}/">${T[g.lang].openings}</a></li></ul></nav>
</article>`;
  const html = guidePage({ lang: g.lang, title: g.title, description: g.description, canonical: url(g), alternates: [[g.lang, url(g)], ...(tw ? [[tw.lang, url(tw)]] : []), ["x-default", url(g.lang === "en" ? g : tw ?? g)]], jsonld }, tw ? `/guides/${tw.lang}/${tw.slug}` : `/guides/${otherLang(g.lang)}/`, body);
  mkdirSync(join(out, "guides", g.lang), { recursive: true });
  writeFileSync(join(out, "guides", g.lang, `${g.slug}.html`), html);
  sitemap.push([url(g), g.modified]);
}

// Opening pages: human copy in content.json, the engine's numbers in engine.json (site/openings/engine.cjs).
const engine = JSON.parse(readFileSync(join(site, "openings/engine.json"), "utf8"));
const content = JSON.parse(readFileSync(join(site, "openings/content.json"), "utf8"));
const openingsModified = gitDate("site/openings");
const O = {
  en: {
    hubTitle: "Best moves in chess openings, checked by an engine",
    hubDesc: "The engine's best move, score and alternatives in the 12 most searched chess openings: 1.e4, 1.d4, Italian, Ruy Lopez, Sicilian, French, Caro-Kann and more.",
    hubLede: "Each page shows one opening position, the move the CaliChess engine likes best, its score, the next best tries, and the plans behind them. Open any of them on the board and keep analyzing.",
    toMove: { white: "White to move", black: "Black to move" },
    side: { white: "White", black: "Black" },
    verdict: "Engine verdict", bestFor: (s) => `Best move for ${s}`, tied: "These moves score the same",
    move: "Move", score: "Score (White's view)", line: "Line the engine expects", plans: "Plans", pitfall: "Common mistake",
    meaning: (w) => Math.abs(w) < 0.1 ? "The position is level." : `${w > 0 ? "White" : "Black"} is ${Math.abs(w) < 0.5 ? "slightly" : Math.abs(w) < 1 ? "" : "clearly"} better`.replace("  ", " ") + ".",
    scoreNote: "Scores are in pawns from White's point of view: +1.00 is about one extra pawn for White.",
    method: (p) => `Calculated by the CaliChess engine (build ${engine.engine}) to depth ${p.depth}, ${(p.nodes / 1e6).toFixed(0)} million positions, on ${engine.date}. Moves within a few hundredths of a pawn can swap places with more time.`,
    analyze: "Analyze this position", movesSoFar: "Moves", boardLabel: (n) => `Chessboard: ${n}`
  },
  es: {
    hubTitle: "Mejores jugadas en las aperturas de ajedrez, revisadas por un motor",
    hubDesc: "La mejor jugada del motor, su evaluación y alternativas en las 12 aperturas más buscadas: 1.e4, 1.d4, Italiana, Española, Siciliana, Francesa, Caro-Kann y más.",
    hubLede: "Cada página muestra una posición de apertura, la jugada que más le gusta al motor de CaliChess, su evaluación, las siguientes mejores y los planes detrás de ellas. Ábrela en el tablero y sigue analizando.",
    toMove: { white: "Juegan blancas", black: "Juegan negras" },
    side: { white: "las blancas", black: "las negras" },
    verdict: "Veredicto del motor", bestFor: (s) => `Mejor jugada para ${s}`, tied: "Estas jugadas valen lo mismo",
    move: "Jugada", score: "Evaluación (vista de blancas)", line: "Línea que espera el motor", plans: "Planes", pitfall: "Error común",
    meaning: (w) => Math.abs(w) < 0.1 ? "La posición está igualada." : `${w > 0 ? "Las blancas están" : "Las negras están"} ${Math.abs(w) < 0.5 ? "un poco mejor" : Math.abs(w) < 1 ? "mejor" : "claramente mejor"}.`,
    scoreNote: "La evaluación está en peones desde el punto de vista de las blancas: +1.00 es más o menos un peón de ventaja para las blancas.",
    method: (p) => `Calculado por el motor de CaliChess (build ${engine.engine}) a profundidad ${p.depth}, ${(p.nodes / 1e6).toFixed(0)} millones de posiciones, el ${engine.date}. Jugadas a pocas centésimas de peón pueden cambiar de lugar con más tiempo.`,
    analyze: "Analizar esta posición", movesSoFar: "Jugadas", boardLabel: (n) => `Tablero: ${n}`
  }
};
const pawns = (w) => (w > 0 ? "+" : w < 0 ? "−" : "") + Math.abs(w / 100).toFixed(2);
// Spanish notation: C caballo, A alfil, T torre, D dama, R rey.
const sanFor = (lang, san) => (lang === "es" ? san.replace(/[NBRQK]/g, (p) => ({ N: "C", B: "A", R: "T", Q: "D", K: "R" })[p]) : san);
const numbered = (sans, startPly, lang = "en") =>
  sans.map((s, i) => {
    const san = sanFor(lang, s);
    const ply = startPly + i;
    if (ply % 2 === 0) return `${ply / 2 + 1}.${san}`;
    return i === 0 ? `${(ply + 1) / 2}...${san}` : san;
  }).join(" ");
const PIECES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
function board(fen, side, label) {
  const rows = fen.split(" ")[0].split("/").map((r) => r.replace(/\d/g, (d) => ".".repeat(+d)).split(""));
  const ranks = side === "white" ? rows : rows.slice().reverse().map((r) => r.slice().reverse());
  const cells = ranks.flatMap((row, r) =>
    row.map((c, f) => {
      const shade = (r + f) % 2 === 0 ? "l" : "d";
      if (c === ".") return `<i class="${shade}"></i>`;
      const color = c === c.toUpperCase() ? "white" : "black";
      return `<i class="${shade}"><img src="/assets/pieces/adr-0206-cburnett/${color}-${PIECES[c.toLowerCase()]}-v1.svg" alt="" width="45" height="45"></i>`;
    })
  );
  return `<div class="board" role="img" aria-label="${esc(label)}">${cells.join("")}</div>`;
}
const openings = content.map((c) => ({ ...c, ...engine.positions.find((p) => p.key === c.key) }));
const openingUrl = (o, lang) => `${ORIGIN}/guides/${lang}/${T[lang].openingsDir}/${o[lang].slug}`;
const hubUrl = (lang) => `${ORIGIN}/guides/${lang}/${T[lang].openingsDir}/`;
for (const lang of ["en", "es"]) {
  const t = T[lang], o = O[lang];
  mkdirSync(join(out, "guides", lang, t.openingsDir), { recursive: true });
  for (const op of openings) {
    const c = op[lang];
    const played = op.moves.split(" ").filter(Boolean);
    const white = (cp) => (op.side === "white" ? cp : -cp);
    const best = op.candidates[0];
    const tied = op.candidates.filter((k) => k.cp === best.cp);
    const bestW = white(best.cp);
    const verdict = tied.length > 1
      ? `${o.tied}: ${tied.map((k) => `<b>${numbered([k.san], played.length, lang)}</b>`).join(", ")} (${pawns(bestW)}).`
      : `${o.bestFor(o.side[op.side])}: <b>${numbered([best.san], played.length, lang)}</b> (${pawns(bestW)}).`;
    const playedText = played.length ? numbered(played, 0, lang) : "—";
    const body = `<article>
<p class="kicker"><a href="/guides/${lang}/${t.openingsDir}/">${t.openings}</a> · ECO ${op.eco} · <time datetime="${engine.date}">${engine.date}</time></p>
<h1>${c.h1}</h1>
<p class="lede">${c.intro}</p>
<figure class="position">${board(op.fen, op.side, o.boardLabel(`${c.name}, ${playedText}, ${o.toMove[op.side]}`))}
<figcaption>${o.movesSoFar}: ${playedText} · ${o.toMove[op.side]}</figcaption></figure>
<div class="eli5"><b>${o.verdict}</b>${verdict} ${o.meaning(bestW / 100)}</div>
<table><thead><tr><th>${o.move}</th><th class="n">${o.score}</th></tr></thead><tbody>
${op.candidates.map((k) => `<tr><td>${numbered([k.san], played.length, lang)}</td><td class="n">${pawns(white(k.cp))}</td></tr>`).join("\n")}
</tbody></table>
<p>${o.scoreNote}</p>
<p><b>${o.line}:</b> ${numbered(op.line, played.length, lang)}</p>
<p class="cta-row"><a class="cta big" href="${t.root}#fen=${encodeURIComponent(op.fen)}">${o.analyze} →</a></p>
<h2>${o.plans}</h2>
<ul>${c.plans.map((p) => `<li>${p}</li>`).join("")}</ul>
<h2>${o.pitfall}</h2>
<p>${c.pitfall}</p>
${faqHtml(lang, c.faq)}
<p class="muted small">${o.method(op)}</p>
<nav class="more"><h2>${t.openings}</h2><ul>${openings.filter((x) => x !== op).map((x) => `<li><a href="/guides/${lang}/${t.openingsDir}/${x[lang].slug}">${x[lang].title}</a></li>`).join("")}</ul></nav>
</article>`;
    const jsonld = [
      { "@context": "https://schema.org", "@type": "TechArticle", headline: c.title, description: c.description, inLanguage: lang, datePublished: engine.date, dateModified: openingsModified, image: `${ORIGIN}/og.png`, author, about: { "@type": "Thing", name: c.name }, mainEntityOfPage: openingUrl(op, lang) },
      breadcrumbs([[t.guides, `${ORIGIN}/guides/${lang}/`], [t.openings, hubUrl(lang)], [c.name, openingUrl(op, lang)]]),
      faqLd(c.faq)
    ];
    const html = guidePage({ lang, title: c.title, description: c.description, canonical: openingUrl(op, lang), alternates: [["en", openingUrl(op, "en")], ["es", openingUrl(op, "es")], ["x-default", openingUrl(op, "en")]], jsonld }, `/guides/${otherLang(lang)}/${T[otherLang(lang)].openingsDir}/${op[otherLang(lang)].slug}`, body);
    writeFileSync(join(out, "guides", lang, t.openingsDir, `${c.slug}.html`), html);
    sitemap.push([openingUrl(op, lang), openingsModified]);
  }
  const hubBody = `<h1>${o.hubTitle}</h1><p class="lede">${o.hubLede}</p>
<ul class="cards">${openings.map((x) => `<li><a href="/guides/${lang}/${t.openingsDir}/${x[lang].slug}"><b>${x[lang].title}</b><span>${x[lang].description}</span></a></li>`).join("")}</ul>`;
  const hubLd = [
    { "@context": "https://schema.org", "@type": "CollectionPage", name: o.hubTitle, inLanguage: lang, url: hubUrl(lang) },
    breadcrumbs([[t.guides, `${ORIGIN}/guides/${lang}/`], [t.openings, hubUrl(lang)]])
  ];
  writeFileSync(join(out, "guides", lang, t.openingsDir, "index.html"), guidePage({ lang, title: o.hubTitle, description: o.hubDesc, canonical: hubUrl(lang), type: "website", alternates: [["en", hubUrl("en")], ["es", hubUrl("es")], ["x-default", hubUrl("en")]], jsonld: hubLd }, `/guides/${otherLang(lang)}/${T[otherLang(lang)].openingsDir}/`, hubBody));
  sitemap.push([hubUrl(lang), openingsModified]);
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
  const openingsCard = `<li><a href="/guides/${lang}/${T[lang].openingsDir}/"><b>${O[lang].hubTitle}</b><span>${O[lang].hubDesc}</span></a></li>`;
  const body = `<h1>${T[lang].guides}</h1><p class="lede">${indexMeta[lang].description}</p>
<ul class="cards">${openingsCard}${list.map((g) => `<li><a href="/guides/${lang}/${g.slug}"><b>${g.title}</b><span>${g.description}</span></a></li>`).join("")}${notebookCard}</ul>`;
  const html = guidePage({ lang, title: indexMeta[lang].title, description: indexMeta[lang].description, canonical, type: "website", alternates: [["en", `${ORIGIN}/guides/en/`], ["es", `${ORIGIN}/guides/es/`], ["x-default", `${ORIGIN}/guides/en/`]], jsonld: { "@context": "https://schema.org", "@type": "CollectionPage", name: indexMeta[lang].title, inLanguage: lang, url: canonical } }, `/guides/${otherLang(lang)}/`, body);
  writeFileSync(join(out, "guides", lang, "index.html"), html);
  sitemap.push([canonical, gitDate(`site/guides/${lang}`, "site/openings")]);
}

// The app pages: / in English, /es/ in Spanish. One URL per language (no switching by browser language),
// each with its search tags and a crawlable intro under the app; the Stockfish analyzer stays hidden.
const HOME = {
  en: {
    title: "Chess Engine in Your Browser: Free Best Move Finder and Analysis | CaliChess",
    description: "Free chess engine that runs in your browser, offline: set up any position and it shows the best move, its score, the alternatives and why, in plain words. About 3000 Elo.",
    h2: "Free chess engine in your browser",
    lede: "Set up any position and CaliChess tells you the best move, how good it is, the alternatives, and why, in one plain sentence. The engine (about 3000 Elo) runs on your own computer through WebAssembly: no download, no account, works offline.",
    howTitle: "How to use it",
    how: ["Play the moves on the board, or paste a position (FEN) under “Load”.", "Pick your side. The engine shows its best move for you, the score and three alternatives.", "Read the one-line reason, try the move, and keep going. Undo any time."],
    whyTitle: "What makes it different",
    why: ["Strong: about 3039 Elo on the CCRL Blitz scale, measured over 600 games.", "Private: the engine runs on your device, nothing you play is uploaded.", "Honest: it tells you how deep it looked and how sure it is."],
    openingsTitle: "Best moves in popular openings",
    guidesTitle: "Guides",
    faq: [["Is CaliChess free?", "Yes. No account, no limits, no ads. The engine runs on your own computer."], ["Does it work offline?", "Yes. Once the page has loaded, the engine runs inside your browser without internet."], ["Can I use it during an online game?", "No. Using an engine while playing a rated game is cheating. Use it to study your games afterwards."]],
    appName: "CaliChess"
  },
  es: {
    title: "Motor de Ajedrez en tu Navegador: Mejor Jugada y Análisis Gratis | CaliChess",
    description: "Motor de ajedrez gratis que corre en tu navegador, sin internet: pon cualquier posición y te muestra la mejor jugada, su evaluación, las alternativas y por qué. Unos 3000 Elo.",
    h2: "Motor de ajedrez gratis en tu navegador",
    lede: "Pon cualquier posición y CaliChess te dice la mejor jugada, qué tan buena es, las alternativas y por qué, en una frase sencilla. El motor (unos 3000 Elo) corre en tu propia computadora con WebAssembly: sin descargar nada, sin cuenta y sin internet.",
    howTitle: "Cómo se usa",
    how: ["Haz las jugadas en el tablero o pega una posición (FEN) en “Load”.", "Elige tu lado. El motor te muestra su mejor jugada, la evaluación y tres alternativas.", "Lee la razón en una línea, prueba la jugada y sigue. Puedes deshacer cuando quieras."],
    whyTitle: "Qué lo hace distinto",
    why: ["Fuerte: unos 3039 Elo en la escala CCRL Blitz, medidos en 600 partidas.", "Privado: el motor corre en tu dispositivo, nada de lo que juegas se sube.", "Honesto: te dice qué tan profundo buscó y qué tan seguro está."],
    openingsTitle: "Mejores jugadas en aperturas populares",
    guidesTitle: "Guías",
    faq: [["¿CaliChess es gratis?", "Sí. Sin cuenta, sin límites y sin anuncios. El motor corre en tu propia computadora."], ["¿Funciona sin internet?", "Sí. Cuando la página ya cargó, el motor corre dentro de tu navegador sin conexión."], ["¿Lo puedo usar durante una partida en línea?", "No. Usar un motor mientras juegas una partida con rating es trampa. Úsalo para estudiar tus partidas después."]],
    appName: "CaliChess"
  }
};
const homeUrl = (lang) => `${ORIGIN}${T[lang].root}`;
const homeModified = gitDate("apps/web", "crates", "site");
const template = readFileSync(join(out, "index.html"), "utf8");
for (const lang of ["en", "es"]) {
  const h = HOME[lang], t = T[lang];
  let app = template;
  const swap = (from, to) => {
    if (!app.includes(from)) throw new Error(`index.html: "${from}" not found`);
    app = app.replace(from, to);
  };
  swap('<html lang="es">', `<html lang="${lang}">`);
  // OWNER 2026-11-20: calichess.cc counts visits with Cloudflare Web Analytics (beacon injected by Cloudflare).
  swap("script-src 'self' 'wasm-unsafe-eval';", "script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com;");
  swap("connect-src 'self'", "connect-src 'self' https://cloudflareinsights.com");
  const jsonld = [
    { "@context": "https://schema.org", "@type": "WebSite", name: "CaliChess", alternateName: ["calichess.cc", "Cali Chess"], url: `${ORIGIN}/`, inLanguage: ["en", "es"] },
    { "@context": "https://schema.org", "@type": "WebApplication", name: h.appName, url: homeUrl(lang), description: h.description, applicationCategory: "GameApplication", applicationSubCategory: lang === "en" ? "Chess analysis" : "Análisis de ajedrez", operatingSystem: "Any (web browser)", browserRequirements: "Requires WebAssembly", inLanguage: lang, isAccessibleForFree: true, offers: { "@type": "Offer", price: "0", priceCurrency: "USD" }, screenshot: `${ORIGIN}/img/explore-dark.webp`, author, sameAs: [REPO_URL] }
  ];
  swap("<title>Chess</title>", meta({ lang, title: h.title, description: h.description, canonical: homeUrl(lang), type: "website", alternates: [["en", homeUrl("en")], ["es", homeUrl("es")], ["x-default", homeUrl("en")]], jsonld }));
  swap('<link rel="stylesheet" href="./play.css">', '<link rel="stylesheet" href="./play.css">\n    <link rel="stylesheet" href="./site.css">');
  const foot = `<footer class="site-foot">
  <p class="lang-switch"><a href="${T[otherLang(lang)].root}" hreflang="${otherLang(lang)}" lang="${otherLang(lang)}">${t.other}</a></p>
  <h2>${h.h2}</h2>
  <p>${h.lede}</p>
  <h3>${h.howTitle}</h3>
  <ol>${h.how.map((s) => `<li>${s}</li>`).join("")}</ol>
  <h3>${h.whyTitle}</h3>
  <ul>${h.why.map((s) => `<li>${s}</li>`).join("")}</ul>
  <h3>${h.openingsTitle}</h3>
  <p class="links">${openings.map((x) => `<a href="/guides/${lang}/${t.openingsDir}/${x[lang].slug}">${x[lang].name}</a>`).join(" · ")}</p>
  <h3>${h.guidesTitle}</h3>
  <p class="links">${guides.filter((g) => g.lang === lang).sort((a, b) => a.order - b.order).map((g) => `<a href="/guides/${lang}/${g.slug}">${g.title}</a>`).join(" · ")} · <a href="/cuaderno-de-reconciliaciones/">${lang === "en" ? "Reconciliation Notebook" : "Cuaderno de Reconciliaciones"}</a> · <a href="${REPO_URL}">${t.repo}</a></p>
  ${faqHtml(lang, h.faq)}
</footer>`;
  swap("</main>", `</main>\n${foot}`);
  if (lang === "es") {
    // /es/ is one level down: make the page's own links root-relative (workers already resolve from the module URL).
    app = app.replaceAll('href="./', 'href="/').replaceAll('src="./', 'src="/');
  }
  mkdirSync(join(out, t.root), { recursive: true });
  writeFileSync(join(out, t.root, "index.html"), app);
  sitemap.unshift([homeUrl(lang), homeModified]);
}

writeFileSync(join(out, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemap.map(([loc, lastmod]) => `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod></url>`).join("\n")}
</urlset>
`);
writeFileSync(join(repo, "target/indexnow-urls.json"), JSON.stringify({ host: "calichess.cc", key: INDEXNOW_KEY, keyLocation: `${ORIGIN}/${INDEXNOW_KEY}.txt`, urlList: sitemap.map(([loc]) => loc) }));
for (const leftover of ["smoke-evidence", "smoke-game-archive", "smoke-analyzer"]) {
  if (existsSync(join(out, leftover))) rmSync(join(out, leftover), { recursive: true });
}
console.log(`site: ${sitemap.length} pages in ${out}`);
