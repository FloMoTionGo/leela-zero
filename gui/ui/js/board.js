// SVG Go board renderer (stones, last move, candidates, territory, policy).
// Browser global window.Board; depends on window.Go for coordinates.
(function (root) {
  "use strict";

  const COLORS = {
    wood: "#d9bb86", grid: "#4a3a22", bstone: "#1f1d1b", wstone: "#f7f5ef", wstroke: "#b9b2a4",
    accent: "#3c78c0", accentInk: "#173a63", panel: "#fbf9f5",
  };
  const MONO = "'IBM Plex Mono', Consolas, monospace";

  function starPoints(n) {
    if (n === 19) return [3, 9, 15].flatMap((x) => [3, 9, 15].map((y) => [x, y]));
    if (n === 13) return [[3, 3], [3, 9], [9, 3], [9, 9], [6, 6]];
    if (n === 9) return [[2, 2], [2, 6], [6, 2], [6, 6], [4, 4]];
    return [];
  }

  const f1 = (v) => v.toFixed(1);

  // state: { size, position, lastMove {x,y}|null, toPlay (Go.BLACK/WHITE),
  //          candidates [{move, winrate (side to move), scoreLead|null, visits, order}],
  //          ownershipBlack Float32Array|null (+1 = Black), showTerritory,
  //          policy Float32Array|null, coords (bool), hover {x,y}|null }
  function render(svg, px, state) {
    const n = state.size, coords = state.coords !== false;
    const m = px * (coords ? 0.055 * Math.sqrt(19 / n) : 0.035);
    const cell = (px - 2 * m) / (n - 1);
    const X = (x) => m + x * cell, Y = (y) => m + y * cell;
    const o = [];
    o.push(`<rect x="0" y="0" width="${px}" height="${px}" rx="${Math.max(4, px * 0.008)}" fill="${COLORS.wood}"/>`);
    for (let i = 0; i < n; i++) {
      const w = ((i === 0 || i === n - 1) ? 1.5 : 0.85) * Math.max(0.6, px / 800);
      o.push(`<line x1="${f1(m)}" y1="${f1(Y(i))}" x2="${f1(px - m)}" y2="${f1(Y(i))}" stroke="${COLORS.grid}" stroke-width="${w.toFixed(2)}" stroke-opacity="0.85"/>`);
      o.push(`<line x1="${f1(X(i))}" y1="${f1(m)}" x2="${f1(X(i))}" y2="${f1(px - m)}" stroke="${COLORS.grid}" stroke-width="${w.toFixed(2)}" stroke-opacity="0.85"/>`);
    }
    for (const [sx, sy] of starPoints(n)) {
      o.push(`<circle cx="${f1(X(sx))}" cy="${f1(Y(sy))}" r="${f1(cell * 0.09)}" fill="${COLORS.grid}"/>`);
    }
    if (coords) {
      const fs = Math.min(cell * 0.36, 15);
      for (let i = 0; i < n; i++) {
        const letter = Go.LETTERS[i];
        const t = (x, y, s) => `<text x="${f1(x)}" y="${f1(y)}" font-size="${f1(fs)}" text-anchor="middle" fill="${COLORS.grid}" fill-opacity="0.7" font-family="${MONO}">${s}</text>`;
        o.push(t(X(i), m * 0.6, letter), t(X(i), px - m * 0.32, letter));
        o.push(t(m * 0.45, Y(i) + fs * 0.35, n - i), t(px - m * 0.45, Y(i) + fs * 0.35, n - i));
      }
    }

    const pos = state.position;
    const deadMarks = [];
    if (state.showTerritory && state.ownershipBlack) {
      for (let i = 0; i < n * n; i++) {
        const own = state.ownershipBlack[i], x = i % n, y = (i / n) | 0;
        const stone = pos.grid[i];
        const fill = own > 0 ? COLORS.bstone : "#ffffff";
        if (stone) {
          if ((own > 0.5 && stone === Go.WHITE) || (own < -0.5 && stone === Go.BLACK)) deadMarks.push([x, y, fill]);
          continue;
        }
        if (Math.abs(own) < 0.2) continue;
        const s = cell * 0.3;
        const edge = own < 0 ? ` stroke="${COLORS.wstroke}" stroke-width="0.6"` : "";
        o.push(`<rect x="${f1(X(x) - s / 2)}" y="${f1(Y(y) - s / 2)}" width="${f1(s)}" height="${f1(s)}" rx="${f1(s * 0.15)}" fill="${fill}" fill-opacity="${Math.min(0.7, Math.abs(own) * 0.75).toFixed(2)}"${edge}/>`);
      }
    }

    if (state.policy) {
      const ranked = [];
      for (let i = 0; i < n * n; i++) if (state.policy[i] > 0.0005) ranked.push([i, state.policy[i]]);
      ranked.sort((a, b) => b[1] - a[1]);
      const labels = new Set(ranked.slice(0, 3).map((r) => r[0]));
      for (const [i, p] of ranked) {
        const x = i % n, y = (i / n) | 0, s = cell * 0.86;
        o.push(`<rect x="${f1(X(x) - s / 2)}" y="${f1(Y(y) - s / 2)}" width="${f1(s)}" height="${f1(s)}" rx="${f1(s * 0.18)}" fill="${COLORS.accent}" fill-opacity="${Math.min(0.92, 0.1 + Math.sqrt(p) * 1.35).toFixed(2)}"/>`);
        if (labels.has(i)) o.push(`<text x="${f1(X(x))}" y="${f1(Y(y) + cell * 0.14)}" font-size="${f1(cell * 0.38)}" text-anchor="middle" fill="#fff" font-family="${MONO}" font-weight="500">${Math.round(p * 100)}</text>`);
      }
    }

    const r = cell * 0.47;
    for (let i = 0; i < n * n; i++) {
      const c = pos.grid[i];
      if (!c) continue;
      const x = X(i % n), y = Y((i / n) | 0);
      o.push(`<circle cx="${f1(x)}" cy="${f1(y + cell * 0.04)}" r="${f1(r)}" fill="#000" fill-opacity="0.16"/>`);
      o.push(c === Go.BLACK
        ? `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}" fill="${COLORS.bstone}"/>`
        : `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}" fill="${COLORS.wstone}" stroke="${COLORS.wstroke}" stroke-width="0.8"/>`);
    }
    if (state.lastMove) {
      const { x, y } = state.lastMove, c = pos.at(x, y);
      if (c) o.push(`<circle cx="${f1(X(x))}" cy="${f1(Y(y))}" r="${f1(r * 0.42)}" fill="none" stroke="${c === Go.BLACK ? "#f7f5ef" : "#1e1d1b"}" stroke-width="${f1(Math.max(1.2, cell * 0.05))}"/>`);
    }
    for (const [x, y, fill] of deadMarks) {
      const s = cell * 0.3;
      o.push(`<rect x="${f1(X(x) - s / 2)}" y="${f1(Y(y) - s / 2)}" width="${f1(s)}" height="${f1(s)}" rx="${f1(s * 0.15)}" fill="${fill}" stroke="${COLORS.wstroke}" stroke-width="0.6"/>`);
    }

    const cands = state.candidates || [];
    const topVisits = Math.max(1, ...cands.map((c) => c.visits));
    for (const c of cands) {
      let v;
      try { v = Go.fromGtp(c.move, n); } catch (e) { v = null; }
      if (!v || pos.at(v.x, v.y)) continue;
      const x = X(v.x), y = Y(v.y), share = c.visits / topVisits;
      let tcol;
      if (c.order === 0) {
        o.push(`<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}" fill="${COLORS.accent}"/>`);
        tcol = "#fff";
      } else {
        o.push(`<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}" fill="${COLORS.panel}"/>`);
        o.push(`<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}" fill="${COLORS.accent}" fill-opacity="${(0.14 + 0.5 * share).toFixed(2)}" stroke="${COLORS.accent}" stroke-width="1.2"/>`);
        tcol = share > 0.55 ? "#fff" : COLORS.accentInk;
      }
      const hasLead = c.scoreLead !== null && c.scoreLead !== undefined;
      o.push(`<text x="${f1(x)}" y="${f1(y + (hasLead ? -cell * 0.02 : cell * 0.1))}" font-size="${f1(cell * 0.31)}" text-anchor="middle" fill="${tcol}" font-family="${MONO}" font-weight="500">${Math.round(c.winrate * 100)}%</text>`);
      if (hasLead) o.push(`<text x="${f1(x)}" y="${f1(y + cell * 0.3)}" font-size="${f1(cell * 0.25)}" text-anchor="middle" fill="${tcol}" fill-opacity="0.9" font-family="${MONO}">${Board.leadText(c.scoreLead)}</text>`);
    }

    if (state.hover && !pos.at(state.hover.x, state.hover.y)) {
      const { x, y } = state.hover;
      const black = state.toPlay === Go.BLACK;
      o.push(`<circle cx="${f1(X(x))}" cy="${f1(Y(y))}" r="${f1(r)}" fill="${black ? COLORS.bstone : COLORS.wstone}" fill-opacity="0.45"${black ? "" : ` stroke="${COLORS.wstroke}" stroke-width="0.8"`}/>`);
    }

    svg.setAttribute("viewBox", `0 0 ${px} ${px}`);
    svg.setAttribute("width", px);
    svg.setAttribute("height", px);
    svg.innerHTML = o.join("");
    svg._geometry = { m, cell, n };
  }

  // Maps a mouse event to a board point, or null when outside.
  function pointFromEvent(svg, event) {
    const g = svg._geometry;
    if (!g) return null;
    const rect = svg.getBoundingClientRect();
    const scale = parseFloat(svg.getAttribute("width")) / rect.width;
    const x = Math.round(((event.clientX - rect.left) * scale - g.m) / g.cell);
    const y = Math.round(((event.clientY - rect.top) * scale - g.m) / g.cell);
    return x >= 0 && y >= 0 && x < g.n && y < g.n ? { x, y } : null;
  }

  function leadText(v) {
    const r = Math.round(v * 10) / 10;
    if (r === 0) return "0.0";
    return (r > 0 ? "+" : "−") + Math.abs(r).toFixed(1);
  }

  const Board = { render, pointFromEvent, leadText, COLORS };
  root.Board = Board;
})(this);
