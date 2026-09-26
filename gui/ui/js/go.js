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

  // ---- SGF: SZ/KM/players/root setup and the move tree with its variations ----
  // parseSgf returns { size, komi, black, white, setup, moves, tree }: tree is the
  // list of first moves, each { move {color, vertex}, children [...] }; moves is
  // its main line (first child all the way down). Nodes without B/W are skipped.
  function parseSgf(text) {
    let i = text.indexOf("(");
    if (i < 0) throw new Error("not an SGF file");
    const skipSpace = () => { while (i < text.length && /\s/.test(text[i])) i++; };
    function parseNode() {  // at ";"
      i++;
      const node = {};
      while (true) {
        skipSpace();
        if (!/[A-Za-z]/.test(text[i] || "")) return node;
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
        node[ident] = (node[ident] || []).concat(values);
        i = j;
      }
    }
    function parseTree() {  // at "("; returns { nodes, children }
      i++;
      const t = { nodes: [], children: [] };
      while (i < text.length) {
        skipSpace();
        const ch = text[i];
        if (ch === ";") t.nodes.push(parseNode());
        else if (ch === "(") t.children.push(parseTree());
        else if (ch === ")") { i++; break; }
        else i++;
      }
      return t;
    }
    const top = parseTree();
    const rootNode = top.nodes[0] || {};
    const size = parseInt((rootNode.SZ || ["19"])[0], 10);
    const sgfPoint = (s) => (s === "" || (size <= 19 && s === "tt") ? null
      : { x: s.charCodeAt(0) - 97, y: s.charCodeAt(1) - 97 });
    const moveOf = (n) => (n.B ? { color: BLACK, vertex: sgfPoint(n.B[0]) }
      : n.W ? { color: WHITE, vertex: sgfPoint(n.W[0]) } : null);
    // the moves that follow node k of sequence t, as a list of branches
    function build(t, k) {
      for (; k < t.nodes.length; k++) {
        const move = moveOf(t.nodes[k]);
        if (move) return [{ move, children: build(t, k + 1) }];
      }
      return t.children.flatMap((c) => build(c, 0));
    }
    const game = {
      size,
      komi: parseFloat((rootNode.KM || ["7.5"])[0]),
      black: (rootNode.PB || [""])[0],
      white: (rootNode.PW || [""])[0],
      setup: [],
      moves: [],
      tree: build(top, 0),
    };
    for (const n of top.nodes) {
      for (const [ident, color] of [["AB", BLACK], ["AW", WHITE]]) {
        for (const v of n[ident] || []) game.setup.push({ color, vertex: sgfPoint(v) });
      }
    }
    for (let list = game.tree; list.length; list = list[0].children) game.moves.push(list[0].move);
    return game;
  }

  // game.tree (as parseSgf returns it; extra node fields are ignored) or,
  // without one, game.moves as a single line.
  function writeSgf(game) {
    const pt = (v) => (v === null ? "" : String.fromCharCode(97 + v.x, 97 + v.y));
    const esc = (s) => String(s).replace(/([\]\\])/g, "\\$1");
    let out = `(;GM[1]FF[4]CA[UTF-8]AP[LeelaZeroGUI]SZ[${game.size}]KM[${game.komi}]`;
    if (game.black) out += `PB[${esc(game.black)}]`;
    if (game.white) out += `PW[${esc(game.white)}]`;
    const ab = game.setup.filter((s) => s.color === BLACK), aw = game.setup.filter((s) => s.color === WHITE);
    if (ab.length) out += "AB" + ab.map((s) => `[${pt(s.vertex)}]`).join("");
    if (aw.length) out += "AW" + aw.map((s) => `[${pt(s.vertex)}]`).join("");
    const node = (n) => `;${n.move.color === BLACK ? "B" : "W"}[${pt(n.move.vertex)}]`;
    // a run of single moves, then one bracketed variation per branch
    function sequence(list) {
      let s = "";
      while (list.length === 1) { s += node(list[0]); list = list[0].children; }
      for (const n of list.length > 1 ? list : []) s += "(" + node(n) + sequence(n.children) + ")";
      return s;
    }
    let tree = game.tree;
    if (!tree) {
      tree = [];
      for (let k = game.moves.length - 1; k >= 0; k--) tree = [{ move: game.moves[k], children: tree }];
    }
    return out + sequence(tree) + ")\n";
  }

  const Go = { LETTERS, EMPTY, BLACK, WHITE, other, toGtp, fromGtp, Position, parseSgf, writeSgf };
  if (typeof module !== "undefined" && module.exports) module.exports = Go;
  else root.Go = Go;
})(this);
