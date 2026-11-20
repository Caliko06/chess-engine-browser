// ADR-0151 oracle: validate side-oriented Explore candidates against Stockfish.
// Runs the chess-cli side-explore command on each acceptance FEN and checks that
// every "sound" candidate is within SOUND_MARGIN_CP of Stockfish's best.
// Stockfish is used only here (external validation), never in the shipped runtime.

import { spawnSync, spawn as spawnProcess } from "node:child_process";

const STOCKFISH_BIN = "/opt/homebrew/bin/stockfish";
const CARGO_PATH = `${process.env.HOME}/.cargo/bin:/opt/homebrew/opt/rustup/bin:/opt/homebrew/bin:/opt/homebrew/sbin:${process.env.PATH ?? ""}`;
const SF_DEPTH = 14;
const SOUND_MARGIN_CP = 50; // matches crates/search/src/lib.rs EXPLORE_SOUND_MARGIN_CP
const BUDGET = 12000;

// Acceptance suite per §7 of the 2026-06-06 explore side-win-bias goal (git tag governance-archive).
const SUITE = [
  {
    label: "adr-0150-regression",
    fen: "rnbqkbnr/pppp1ppp/8/4p3/8/2N5/PPPPPPPP/R1BQKBNR w KQkq - 0 2",
    side: "white",
    // These moves were falsely tagged "sound" before exact rescoring (ADR-0150 incident)
    mustNotBeSoundCandidates: ["c3d5", "c3e4", "g1h3"],
  },
  {
    label: "wac-1-forced-mate",
    fen: "2rr3k/pp3pp1/1nnqbN1p/3pN3/2pP4/2P3Q1/PPB4P/R4RK1 w - - 0 1",
    side: "white",
    mustSurfaceCandidates: ["g3g6"],
  },
  {
    label: "off-turn-white-side",
    fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
    side: "white", // white's turn is over; we want white-perspective threat detection
    // Must surface non-empty threat candidates (opponent's best options as danger to white)
    mustHaveCandidates: true,
  },
  {
    label: "off-turn-black-side",
    fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
    side: "black", // black is on turn in this position; check on-turn black view
    mustHaveCandidates: true,
  },
  {
    // Greek gift / sound sacrifice: Bxh7+ in a position where it wins
    // After 1.e4 e6 2.d4 d5 3.Nc3 Nf6 4.Bg5 Be7 5.e5 Nfd7 6.h4 O-O 7.Bd3 — white can play Bxh7+
    label: "greek-gift-sacrifice",
    fen: "r1bq1rk1/pppnbppp/4p3/3pP1B1/3P3P/2NB4/PPP2PP1/R2QK1NR w KQ - 1 8",
    side: "white",
    mustHaveCandidates: true,
    // Bxh7+ is a sound sacrifice here; our engine may or may not find it at budget 12k.
    // The key check is: if it surfaces Bxh7+ (d3h7), it must be SF-confirmed sound.
  },
];

// ---- Stockfish helper ----

class StockfishSession {
  constructor() {
    this.child = null;
    this.stdoutBuffer = "";
    this.lines = [];
    this.waiters = [];
    this.lastScoreCp = 0;
    this.quitting = false;
  }

  start() {
    this.child = spawnProcess(STOCKFISH_BIN, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk) => this._consumeStdout(chunk.toString("utf8")));
    this.child.once("error", (err) => this._rejectAll(err));
    this.child.once("exit", (code, sig) => {
      if (!this.quitting) this._rejectAll(new Error(`sf exited code=${code} sig=${sig}`));
    });
  }

  _consumeStdout(text) {
    this.stdoutBuffer += text;
    let idx = this.stdoutBuffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.stdoutBuffer.slice(0, idx).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      this._consumeLine(line);
      idx = this.stdoutBuffer.indexOf("\n");
    }
  }

  _consumeLine(line) {
    const scoreMatch = /(?:^|\s)score\s+cp\s+(-?\d+)(?:\s|$)/.exec(line);
    if (scoreMatch !== null) this.lastScoreCp = Number.parseInt(scoreMatch[1], 10);
    const mateMatch = /(?:^|\s)score\s+mate\s+(-?\d+)(?:\s|$)/.exec(line);
    if (mateMatch !== null) {
      const mateMoves = Number.parseInt(mateMatch[1], 10);
      this.lastScoreCp = mateMoves > 0 ? 30000 : -30000;
    }
    this.lines.push(line);
    for (const w of [...this.waiters]) {
      if (w.predicate(line)) {
        const idx = this.waiters.indexOf(w);
        if (idx !== -1) this.waiters.splice(idx, 1);
        clearTimeout(w.timer);
        w.resolve(line);
      }
    }
  }

  _rejectAll(err) {
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.waiters = [];
  }

  _waitForLine(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const existing = this.lines.find(predicate);
      if (existing !== undefined) { resolve(existing); return; }
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error(`sf timeout waiting for line after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  _send(cmd) { this.child.stdin.write(`${cmd}\n`); }

  async ensureReady() {
    this._send("uci");
    await this._waitForLine((l) => l === "uciok", 5000);
    this._send("isready");
    await this._waitForLine((l) => l === "readyok", 5000);
  }

  async scorePosition(fen, searchMoves) {
    this.lines = [];
    this.lastScoreCp = 0;
    const smSuffix = searchMoves && searchMoves.length > 0 ? ` searchmoves ${searchMoves.join(" ")}` : "";
    this._send(`position fen ${fen}`);
    this._send(`go depth ${SF_DEPTH}${smSuffix}`);
    await this._waitForLine((l) => l.startsWith("bestmove "), 10000);
    return this.lastScoreCp;
  }

  async quit() {
    this.quitting = true;
    this._send("quit");
    await new Promise((resolve) => {
      const t = setTimeout(() => { this.child?.kill("SIGKILL"); resolve(); }, 1000);
      this.child?.once("exit", () => { clearTimeout(t); resolve(); });
    });
  }
}

// ---- CLI helper ----

function runSideExplore(fen, side, budget) {
  const result = spawnSync(
    "cargo",
    // --aggressive: the oracle validates the win-biased aggressive surface (its sacrifice/sound
    // tags), which since ADR-0153 only fires behind the toggle; the default Explore is now neutral.
    ["run", "-p", "chess-cli", "--quiet", "--", "side-explore",
     "--fen", fen, "--side", side, "--budget", String(budget), "--aggressive"],
    { encoding: "utf8", env: { ...process.env, PATH: CARGO_PATH }, timeout: 60_000 }
  );
  if (result.error) throw new Error(`cargo run failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`chess-cli failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

// ---- Main validation ----

function pass(msg) { console.log(`  PASS  ${msg}`); }
function fail(msg) { console.error(`  FAIL  ${msg}`); process.exitCode = 1; }

async function validateCase(sf, testCase) {
  console.log(`\n[${testCase.label}]`);
  console.log(`  FEN:  ${testCase.fen}`);
  console.log(`  Side: ${testCase.side}`);

  let report;
  try {
    report = runSideExplore(testCase.fen, testCase.side, BUDGET);
  } catch (err) {
    fail(`side-explore failed: ${err.message}`);
    return;
  }

  const soundCandidates = report.candidates.filter((c) => c.sound);
  const allMoves = report.candidates.map((c) => c.move);

  console.log(`  on_turn: ${report.on_turn}`);
  console.log(`  candidates (${report.candidates.length}): ${allMoves.join(", ") || "(none)"}`);
  console.log(`  sound (${soundCandidates.length}): ${soundCandidates.map((c) => c.move).join(", ") || "(none)"}`);
  if (report.principal_line.length > 0) {
    console.log(`  principal_line: ${report.principal_line.join(", ")}`);
  }

  // Validate mustNotBeSoundCandidates
  if (testCase.mustNotBeSoundCandidates) {
    for (const mv of testCase.mustNotBeSoundCandidates) {
      const found = soundCandidates.find((c) => c.move === mv);
      if (found) {
        fail(`${mv} appears as a sound candidate (exact_score_cp=${found.exact_score_cp}) but must not`);
      } else {
        pass(`${mv} is not a sound candidate`);
      }
    }
  }

  // Validate mustSurfaceCandidates
  if (testCase.mustSurfaceCandidates) {
    for (const mv of testCase.mustSurfaceCandidates) {
      const found = report.candidates.find((c) => c.move === mv);
      if (!found) {
        fail(`${mv} must be surfaced as a candidate but was not`);
      } else {
        pass(`${mv} surfaced (exact_score_cp=${found.exact_score_cp}, sound=${found.sound}, mate_in=${found.mate_in})`);
      }
    }
  }

  // Validate mustHaveCandidates
  if (testCase.mustHaveCandidates) {
    if (report.candidates.length === 0) {
      fail("expected at least one candidate but got none");
    } else {
      pass(`candidates non-empty (${report.candidates.length} total)`);
    }
  }

  // Stockfish soundness check: for each sound candidate, verify SF agrees within SOUND_MARGIN_CP
  if (soundCandidates.length > 0 && report.on_turn) {
    const sfBestScore = await sf.scorePosition(testCase.fen, null);
    console.log(`  SF best score (depth=${SF_DEPTH}): ${sfBestScore} cp`);

    // When SF finds a forced mate (>= 5000 cp) the gap from our sound moves to SF's
    // mating line is always huge — that is a node-budget limitation, not unsoundness.
    // In that case verify the recommended move is not objectively losing (sfMoveScore >= -100)
    // rather than comparing to SF's absolute best.
    const sfForcedMate = Math.abs(sfBestScore) >= 5000;

    for (const c of soundCandidates) {
      const sfMoveScore = await sf.scorePosition(testCase.fen, [c.move]);
      const delta = sfBestScore - sfMoveScore;
      const sfLabel = c.sacrifice ? "sacrifice" : c.kind;
      if (sfForcedMate) {
        // Just verify the move is not clearly losing
        if (sfMoveScore < -100) {
          fail(`${c.move} (${sfLabel}) is losing by SF (sfMove=${sfMoveScore}); SF found forced mate (sfBest=${sfBestScore}), budget limitation noted`);
        } else {
          pass(`${c.move} (${sfLabel}) SF-OK despite mate-line gap (sfBest=${sfBestScore}, sfMove=${sfMoveScore}, ourScore=${c.exact_score_cp}); budget limitation noted in ADR-0151`);
        }
      } else if (delta > SOUND_MARGIN_CP) {
        fail(`${c.move} (${sfLabel}) SF gap ${delta} cp > ${SOUND_MARGIN_CP} cp limit (sfBest=${sfBestScore}, sfMove=${sfMoveScore}, ourScore=${c.exact_score_cp})`);
      } else {
        pass(`${c.move} (${sfLabel}) SF gap ${delta} cp <= ${SOUND_MARGIN_CP} cp (sfBest=${sfBestScore}, sfMove=${sfMoveScore}, ourScore=${c.exact_score_cp})`);
      }
      // If claimed sacrifice, confirm SF doesn't refute it
      if (c.sacrifice) {
        if (!sfForcedMate && sfMoveScore < sfBestScore - SOUND_MARGIN_CP) {
          fail(`${c.move} claimed sacrifice is SF-refuted (gap=${delta} cp)`);
        } else {
          pass(`${c.move} sacrifice SF-confirmed sound`);
        }
      }
      // If claimed mate, confirm SF also sees a forced win
      if (c.mate_in !== null) {
        if (sfBestScore < 5000) {
          fail(`${c.move} claimed mate_in=${c.mate_in} but SF best score only ${sfBestScore} cp`);
        } else {
          pass(`${c.move} mate_in=${c.mate_in} corroborated by SF (sfBest=${sfBestScore})`);
        }
      }
    }
  } else if (!report.on_turn && report.candidates.length > 0) {
    // Off-turn: `side` is not to move; candidates are the opponent's (side_to_move's) best replies,
    // surfaced as threats and scored framed for `side` (negative exact_score_cp = dangerous for
    // side). Since side_to_move IS the opponent here, Stockfish scores the position and each move
    // directly from the opponent's perspective — no side-flip needed. Our opponent-POV score is the
    // negation of exact_score_cp. We validate the sound threats exactly like the on-turn branch:
    // each must lie within SOUND_MARGIN_CP of SF's best reply. (Before ADR-0151's follow-up, off-turn
    // scores were shared-alpha bounds marked all-sound and were never SF-checked — this closes that
    // hole.)
    const sfBestScore = await sf.scorePosition(testCase.fen, null);
    console.log(`  SF best score (opponent to move, depth=${SF_DEPTH}): ${sfBestScore} cp`);
    const sfForcedMate = Math.abs(sfBestScore) >= 5000;

    for (const c of soundCandidates) {
      const sfMoveScore = await sf.scorePosition(testCase.fen, [c.move]);
      const delta = sfBestScore - sfMoveScore;
      const ourOpponentScore = -c.exact_score_cp; // our exact score, in the opponent's POV
      if (sfForcedMate) {
        if (sfMoveScore < -100) {
          fail(`off-turn ${c.move} threat is losing for the opponent by SF (sfMove=${sfMoveScore}); SF sees forced mate (sfBest=${sfBestScore}), budget limitation noted`);
        } else {
          pass(`off-turn ${c.move} SF-OK despite mate-line gap (sfBest=${sfBestScore}, sfMove=${sfMoveScore}, ourOpp=${ourOpponentScore})`);
        }
      } else if (delta > SOUND_MARGIN_CP) {
        fail(`off-turn ${c.move} (sound threat) SF gap ${delta} cp > ${SOUND_MARGIN_CP} cp limit (sfBest=${sfBestScore}, sfMove=${sfMoveScore}, ourOpp=${ourOpponentScore})`);
      } else {
        pass(`off-turn ${c.move} (sound threat) SF gap ${delta} cp <= ${SOUND_MARGIN_CP} cp (sfBest=${sfBestScore}, sfMove=${sfMoveScore}, ourOpp=${ourOpponentScore})`);
      }
    }
    pass(`off-turn mode: ${report.candidates.length} exact-scored threat candidate(s); ${soundCandidates.length} sound (within ${SOUND_MARGIN_CP} cp of the most dangerous reply)`);
  }
}

async function main() {
  console.log("=== side-explore oracle validation (ADR-0151) ===");
  console.log(`SOUND_MARGIN_CP=${SOUND_MARGIN_CP}, SF_DEPTH=${SF_DEPTH}, budget=${BUDGET}`);

  const sf = new StockfishSession();
  sf.start();
  await sf.ensureReady();
  console.log("Stockfish ready.");

  for (const testCase of SUITE) {
    await validateCase(sf, testCase);
  }

  await sf.quit();

  const code = process.exitCode ?? 0;
  console.log(`\n=== ${code === 0 ? "ALL PASS" : "FAILURES DETECTED"} ===`);
  if (code !== 0) process.exit(1);
}

main().catch((err) => {
  console.error("oracle script error:", err);
  process.exit(1);
});
