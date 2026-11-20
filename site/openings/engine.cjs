// Precomputes the engine analysis for the opening pages (needs chess.js; run from a folder where it is installed):
//   NODE_PATH=<dir>/node_modules node site/openings/engine.cjs "$PWD" > site/openings/engine.json
const { Chess } = require("chess.js");
const { execFileSync } = require("child_process");
const repo = process.argv[2];
const positions = [["start-position",""],["after-e4","e4"],["after-d4","d4"],["after-e4-e5","e4 e5"],["italian-game","e4 e5 Nf3 Nc6 Bc4"],["ruy-lopez","e4 e5 Nf3 Nc6 Bb5"],["sicilian-defense","e4 c5"],["french-defense","e4 e6"],["caro-kann-defense","e4 c6"],["scandinavian-defense","e4 d5"],["queens-gambit","d4 d5 c4"],["london-system","d4 d5 Bf4"]];
const BUDGET = 10000000;
const sha = execFileSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"]).toString().trim();
const out = { engine: sha, budget: BUDGET, date: new Date().toISOString().slice(0, 10), positions: [] };
for (const [key, moves] of positions) {
  const g = new Chess();
  for (const m of moves.split(" ").filter(Boolean)) g.move(m);
  const fen = g.fen(), side = g.turn() === "w" ? "white" : "black";
  const r = JSON.parse(execFileSync(`${repo}/target/release/chess-cli`, ["side-explore", "--fen", fen, "--side", side, "--budget", String(BUDGET)]).toString());
  const san = (uci, at = fen) => { const b = new Chess(at); return b.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san; };
  const line = []; const b = new Chess(fen);
  for (const u of r.principal_line) line.push(b.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san);
  out.positions.push({ key, moves, fen, side, depth: r.depth, nodes: r.nodes,
    candidates: r.candidates.map((c) => ({ san: san(c.move), uci: c.move, cp: c.exact_score_cp, mate: c.mate_in })), line });
  process.stderr.write(`${key}: d${r.depth} ${out.positions.at(-1).candidates.map((c) => c.san + " " + c.cp).join(", ")}\n`);
}
console.log(JSON.stringify(out, null, 1));
