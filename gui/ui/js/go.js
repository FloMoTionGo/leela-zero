// Go rules, GTP coordinates and SGF (main line) for the GUI.
// Works as a browser global (window.Go) and as a CommonJS module for tests.
(function (root) {
  "use strict";

  const LETTERS = "ABCDEFGHJKLMNOPQRST";  // GTP skips I
  const EMPTY = 0, BLACK = 1, WHITE = 2;

  // x: 0 = left column, y: 0 = top row (screen order).
  function toGtp(x, y, size) { return LETTERS[x] + (size - y); }

  function fromGtp(vertex, size) {
    const v = vertex.trim().toUpperCase();
    if (v === "PASS" || v === "RESIGN") return null;
    const x = LETTERS.indexOf(v[0]);
    const row = parseInt(v.slice(1), 10);
    if (x < 0 || x >= size || !(row >= 1 && row <= size)) throw new Error("bad vertex " + vertex);
    return { x, y: size - row };
  }

  const other = (color) => (color === BLACK ? WHITE : BLACK);

  class Position {
    constructor(size) {
      this.size = size;
      this.grid = new Int8Array(size * size);
      this.ko = -1;              // point that may not be retaken immediately
      this.captures = [0, 0, 0]; // indexed by the capturing color
    }

    clone() {
      const p = new Position(this.size);
      p.grid.set(this.grid);
      p.ko = this.ko;
      p.captures = this.captures.slice();
      return p;
    }

    at(x, y) { return this.grid[y * this.size + x]; }

    neighbors(i) {
      const n = this.size, x = i % n, out = [];
      if (x > 0) out.push(i - 1);
      if (x < n - 1) out.push(i + 1);
      if (i >= n) out.push(i - n);
      if (i < n * n - n) out.push(i + n);
      return out;
    }

    // Returns {stones, liberties} for the group containing point i.
    group(i) {
      const color = this.grid[i], stones = [i], seen = new Set([i]), libs = new Set();
      for (let k = 0; k < stones.length; k++) {
        for (const nb of this.neighbors(stones[k])) {
          const c = this.grid[nb];
          if (c === EMPTY) libs.add(nb);
          else if (c === color && !seen.has(nb)) { seen.add(nb); stones.push(nb); }
        }
      }
      return { stones, liberties: libs.size };
    }

    // Returns the new position, or null if the move is illegal.
    // vertex null = pass.
    play(color, vertex) {
      const next = this.clone();
      next.ko = -1;
      if (vertex === null) return next;
      const i = vertex.y * this.size + vertex.x;
      if (this.grid[i] !== EMPTY || i === this.ko) return null;
      next.grid[i] = color;
      let captured = [];
      for (const nb of next.neighbors(i)) {
        if (next.grid[nb] === other(color)) {
          const g = next.group(nb);
          if (g.liberties === 0) {
            for (const s of g.stones) next.grid[s] = EMPTY;
            captured = captured.concat(g.stones);
          }
        }
      }
      const own = next.group(i);
      if (own.liberties === 0) return null;  // suicide
      next.captures[color] += captured.length;
      if (captured.length === 1 && own.stones.length === 1 && own.liberties === 1) next.ko = captured[0];
      return next;
    }
  }

  // ---- SGF: main line only, enough for SZ/KM/players/setup/moves ----
  function parseSgf(text) {
    const props = [];  // [{ident, values}] per node, main line
    let i = text.indexOf("(");
    if (i < 0) throw new Error("not an SGF file");
    let depth = 0, node = null, inMainLine = true;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "(") { depth++; if (depth > 1 && node === null) inMainLine = false; i++; continue; }
      if (ch === ")") { depth--; inMainLine = false; i++; continue; }  // first variation ends the main line
      if (ch === ";") { if (inMainLine) { node = {}; props.push(node); } i++; continue; }
      if (/[A-Z]/.test(ch)) {
        let j = i;
        while (/[A-Za-z]/.test(text[j])) j++;
        const ident = text.slice(i, j).replace(/[a-z]/g, "");
        const values = [];
        while (true) {
          while (/\s/.test(text[j])) j++;
          if (text[j] !== "[") break;
          let k = j + 1, v = "";
          while (k < text.length && text[k] !== "]") { if (text[k] === "\\") k++; v += text[k]; k++; }
          values.push(v);
          j = k + 1;
        }
        if (inMainLine && node) node[ident] = (node[ident] || []).concat(values);
        i = j;
        continue;
      }
      i++;
    }
    const rootNode = props[0] || {};
    const size = parseInt((rootNode.SZ || ["19"])[0], 10);
    const sgfPoint = (s) => (s === "" || (size <= 19 && s === "tt") ? null
      : { x: s.charCodeAt(0) - 97, y: s.charCodeAt(1) - 97 });
    const game = {
      size,
      komi: parseFloat((rootNode.KM || ["7.5"])[0]),
      black: (rootNode.PB || [""])[0],
      white: (rootNode.PW || [""])[0],
      setup: [],
      moves: [],
    };
    for (const n of props) {
      for (const [ident, color] of [["AB", BLACK], ["AW", WHITE]]) {
        for (const v of n[ident] || []) game.setup.push({ color, vertex: sgfPoint(v) });
      }
      for (const [ident, color] of [["B", BLACK], ["W", WHITE]]) {
        if (n[ident]) game.moves.push({ color, vertex: sgfPoint(n[ident][0]) });
      }
    }
    return game;
  }

  function writeSgf(game) {
    const pt = (v) => (v === null ? "" : String.fromCharCode(97 + v.x, 97 + v.y));
    const esc = (s) => String(s).replace(/([\]\\])/g, "\\$1");
    let out = `(;GM[1]FF[4]CA[UTF-8]AP[LeelaZeroGUI]SZ[${game.size}]KM[${game.komi}]`;
    if (game.black) out += `PB[${esc(game.black)}]`;
    if (game.white) out += `PW[${esc(game.white)}]`;
    const ab = game.setup.filter((s) => s.color === BLACK), aw = game.setup.filter((s) => s.color === WHITE);
    if (ab.length) out += "AB" + ab.map((s) => `[${pt(s.vertex)}]`).join("");
    if (aw.length) out += "AW" + aw.map((s) => `[${pt(s.vertex)}]`).join("");
    for (const m of game.moves) out += `;${m.color === BLACK ? "B" : "W"}[${pt(m.vertex)}]`;
    return out + ")\n";
  }

  const Go = { LETTERS, EMPTY, BLACK, WHITE, other, toGtp, fromGtp, Position, parseSgf, writeSgf };
  if (typeof module !== "undefined" && module.exports) module.exports = Go;
  else root.Go = Go;
})(this);
