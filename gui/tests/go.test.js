// Unit tests for gui/ui/js/go.js. Run with any Node, e.g. VS Code's:
//   ELECTRON_RUN_AS_NODE=1 "<VS Code>/Code.exe" gui/tests/go.test.js
"use strict";
const assert = require("assert");
const Go = require("../ui/js/go.js");
const { BLACK, WHITE, Position, fromGtp, toGtp } = Go;

let failures = 0;
function test(name, fn) {
  try { fn(); console.log("PASS", name); }
  catch (e) { failures++; console.log("FAIL", name, "-", e.message); }
}

// Plays "b D4"-style moves; throws on illegal moves.
function playAll(size, moves) {
  let p = new Position(size);
  for (const m of moves) {
    const [c, v] = m.split(" ");
    const next = p.play(c === "b" ? BLACK : WHITE, fromGtp(v, size));
    if (!next) throw new Error("illegal: " + m);
    p = next;
  }
  return p;
}
const stoneAt = (p, v) => { const { x, y } = fromGtp(v, p.size); return p.at(x, y); };

test("GTP coordinates skip I and count rows from the bottom", () => {
  assert.deepStrictEqual(fromGtp("J1", 19), { x: 8, y: 18 });
  assert.strictEqual(toGtp(0, 0, 19), "A19");
  assert.strictEqual(toGtp(8, 8, 9), "J1");
  assert.strictEqual(fromGtp("pass", 19), null);
});

test("single stone capture removes it and counts it", () => {
  const p = playAll(9, ["b E5", "w E6", "b A1", "w D5", "b A2", "w F5", "b A3", "w E4"]);
  assert.strictEqual(stoneAt(p, "E5"), 0);
  assert.strictEqual(p.captures[WHITE], 1);
});

test("corner group capture", () => {
  const p = playAll(9, ["b A1", "w B1", "b A2", "w B2", "b J9", "w A3"]);
  assert.strictEqual(stoneAt(p, "A1"), 0);
  assert.strictEqual(stoneAt(p, "A2"), 0);
  assert.strictEqual(p.captures[WHITE], 2);
});

test("suicide is illegal", () => {
  const p = playAll(9, ["b B1", "w J9", "b A2"]);
  assert.strictEqual(p.play(WHITE, fromGtp("A1", 9)), null);
});

test("capturing is not suicide", () => {
  const p = playAll(9, ["b B1", "w A2", "b J9", "w B2", "b J8", "w C1"]);
  // Black B1 is in atari; white A1 would have no liberties but captures B1.
  const next = p.play(WHITE, fromGtp("A1", 9));
  assert.ok(next);
  assert.strictEqual(stoneAt(next, "B1"), 0);
});

test("ko: immediate recapture is illegal, allowed after a move elsewhere", () => {
  // Black D5 C4 D3 E4, white E5 F4 E3; white D4 takes E4 and black may not retake at once.
  const p = playAll(9, ["b D5", "w E5", "b C4", "w F4", "b D3", "w E3", "b E4", "w J9", "b J1", "w D4"]);
  assert.strictEqual(stoneAt(p, "E4"), 0, "white D4 should capture E4");
  assert.strictEqual(p.play(BLACK, fromGtp("E4", 9)), null, "immediate retake is ko");
  const later = p.play(BLACK, fromGtp("A9", 9)).play(WHITE, fromGtp("A8", 9));
  assert.ok(later.play(BLACK, fromGtp("E4", 9)), "retake allowed after exchange elsewhere");
});

test("SGF round trip keeps size, komi, players, setup and moves", () => {
  const game = {
    size: 13, komi: 6.5, black: "Human", white: "KataGo [b18]",
    setup: [{ color: BLACK, vertex: { x: 3, y: 3 } }],
    moves: [{ color: WHITE, vertex: { x: 9, y: 9 } }, { color: BLACK, vertex: null }],
  };
  const back = Go.parseSgf(Go.writeSgf(game));
  assert.deepStrictEqual(back, game);
});

test("SGF parser follows the main line and ignores variations", () => {
  const g = Go.parseSgf("(;SZ[9]KM[7];B[ee](;W[cc];B[gg])(;W[gc]))");
  assert.deepStrictEqual(g.moves.map((m) => m.vertex), [{ x: 4, y: 4 }, { x: 2, y: 2 }, { x: 6, y: 6 }]);
});

console.log(failures === 0 ? "ALL PASS" : failures + " FAILED");
process.exit(failures ? 1 : 0);
