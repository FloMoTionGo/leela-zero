// Unit tests for gui/ui/js/gtp.js. Run with any Node, e.g. VS Code's:
//   ELECTRON_RUN_AS_NODE=1 "<VS Code>/Code.exe" gui/tests/gtp.test.js
"use strict";
const assert = require("assert");
const Gtp = require("../ui/js/gtp.js");

let failures = 0;
const pending = [];
function test(name, fn) {
  pending.push((async () => {
    try { await fn(); console.log("PASS", name); }
    catch (e) { failures++; console.log("FAIL", name, "-", e.message); }
  })());
}

// Captured from Leela Zero 0.17 lz-analyze (trimmed to three candidates).
const LZ_LINE = "info move C2 visits 5376 winrate 4747 prior 301 lcb 4716 order 0 pv C2 B2 C6 D2 " +
  "info move C6 visits 14961 winrate 4663 prior 4396 lcb 4642 order 1 pv C6 C7 C2 B8 " +
  "info move K3 visits 2166 winrate 4521 prior 2274 lcb 4478 order 2 pv K3 C7 C2";

// KataGo 1.18 kata-analyze format on 9x9 with ownership (values shortened).
const own81 = Array.from({ length: 81 }, (_, i) => ((i % 9) - 4) / 4).join(" ");
const KATA_LINE = "info move G4 visits 728 edgeVisits 728 utility 0.360251 winrate 0.670255 scoreMean 1.3176 " +
  "scoreStdev 5.1 scoreLead 1.3176 scoreSelfplay 1.2 prior 0.0603217 lcb 0.69416 utilityLcb 0.427184 weight 495.511 " +
  "order 0 pv G4 F6 F4 info move E6 visits 1930 edgeVisits 1930 utility 0.388047 winrate 0.637837 scoreMean 1.25 " +
  "scoreStdev 5.0 scoreLead 1.25434 scoreSelfplay 1.1 prior 0.655086 lcb 0.654054 utilityLcb 0.433454 weight 1273.09 " +
  "order 1 pv E6 F7 D3 ownership " + own81;

test("lz-analyze: scales 0..10000 to 0..1, keeps order and pv, no score lead", () => {
  const { candidates, ownership } = Gtp.parseInfoLine(LZ_LINE, "leelaz");
  assert.strictEqual(candidates.length, 3);
  assert.strictEqual(ownership, null);
  const [c2, c6] = candidates;
  assert.strictEqual(c2.move, "C2");
  assert.strictEqual(c2.visits, 5376);
  assert.ok(Math.abs(c2.winrate - 0.4747) < 1e-9);
  assert.ok(Math.abs(c6.prior - 0.4396) < 1e-9);
  assert.strictEqual(c2.scoreLead, null);
  assert.deepStrictEqual(c6.pv, ["C6", "C7", "C2", "B8"]);
});

test("kata-analyze: score lead, order and ownership are parsed", () => {
  const { candidates, ownership } = Gtp.parseInfoLine(KATA_LINE, "katago");
  assert.deepStrictEqual(candidates.map((c) => c.move), ["G4", "E6"]);
  assert.ok(Math.abs(candidates[1].scoreLead - 1.25434) < 1e-9);
  assert.deepStrictEqual(candidates[1].pv, ["E6", "F7", "D3"], "pv must stop before ownership");
  assert.strictEqual(ownership.length, 81);
  assert.strictEqual(ownership[0], -1);
  assert.strictEqual(ownership[8], 1);
});

test("kata-raw-nn: policy grid with NaN for stones and pass probability", () => {
  const rows = ["0.1 0.2 0.3", "NAN 0.05 0.05", "0.1 0.1 0.05"];
  const r = Gtp.parseRawNn(["= symmetry 0", "whiteWin 0.38", "policy", ...rows, "policyPass 0.05"], 3);
  assert.ok(Number.isNaN(r.policy[3]));
  assert.ok(Math.abs(r.policy[2] - 0.3) < 1e-6);
  assert.strictEqual(r.pass, 0.05);
  assert.strictEqual(r.whiteWin, 0.38);
});

function fakeEngine() {
  const sent = [];
  const engine = new Gtp.Engine("e", "katago", { send: (...f) => sent.push(f.join("\t")) });
  const feed = (...lines) => lines.forEach((l) => engine.onLine("out", l));
  return { engine, sent, feed };
}

test("commands run one at a time and resolve with their reply", async () => {
  const { engine, sent, feed } = fakeEngine();
  const a = engine.command("name"), b = engine.command("version");
  assert.deepStrictEqual(sent, ["send\te\tname"], "second command waits");
  feed("= KataGo", "");
  assert.strictEqual(await a, "KataGo");
  assert.deepStrictEqual(sent, ["send\te\tname", "send\te\tversion"]);
  feed("= 1.18.1", "");
  assert.strictEqual(await b, "1.18.1");
});

test("error replies reject", async () => {
  const { engine, feed } = fakeEngine();
  const p = engine.command("play b Z99");
  feed("? illegal move", "");
  await assert.rejects(p, /illegal move/);
});

test("a command interrupts streaming analysis and gets its own reply", async () => {
  const { engine, sent, feed } = fakeEngine();
  const infos = [];
  const analysis = engine.analyze("kata-analyze interval 50", (i) => infos.push(i));
  feed("=", KATA_LINE, KATA_LINE);
  assert.strictEqual(infos.length, 2);
  const play = engine.command("play b D4");
  assert.strictEqual(sent[1], "send\te\tplay b D4", "sent immediately to stop the analysis");
  const after = engine.command("genmove w");
  assert.strictEqual(sent.length, 2, "further commands wait");
  feed("");                      // analysis ends
  await analysis;
  feed("=", "");                 // play reply
  assert.strictEqual(await play, "");
  assert.strictEqual(sent[2], "send\te\tgenmove w");
  feed("= E5", "");
  assert.strictEqual(await after, "E5");
});

test("stderr lines go to onStderr and do not disturb replies", async () => {
  const { engine, feed } = fakeEngine();
  const errs = [];
  engine.onStderr = (t) => errs.push(t);
  const p = engine.command("name");
  engine.onLine("err", "= not a reply");
  feed("= KataGo", "");
  assert.strictEqual(await p, "KataGo");
  assert.deepStrictEqual(errs, ["= not a reply"]);
});

Promise.all(pending).then(() => {
  console.log(failures === 0 ? "ALL PASS" : failures + " FAILED");
  process.exit(failures ? 1 : 0);
});
