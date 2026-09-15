// SVG Go board renderer (stones, last move, candidates, territory, policy).
// Browser global window.Board; depends on window.Go for coordinates.
(function (root) {
  "use strict";

  const MONO = "'Cascadia Mono', Consolas, monospace";

  // Colours come from the active scheme's CSS custom properties (style.css),
  // read once per scheme change.
  let cachedColors = null, cachedScheme = null;
  function colors() {
    const scheme = document.documentElement.dataset.scheme || "light";
    if (cachedColors && cachedScheme === scheme) return cachedColors;
    const css = getComputedStyle(document.documentElement);
    const v = (name) => css.getPropertyValue(name).trim();
    const edge = (name) => (v(name) && v(name) !== "none" ? v(name) : null);
    cachedScheme = scheme;
    cachedColors = {
      board: v("--board"), grid: v("--grid"), coord: v("--coord"), panel: v("--panel"),
      bstone: v("--stone-black"), wstone: v("--stone-white"),
      bedge: edge("--stone-black-edge"), wedge: edge("--stone-white-edge"),
      accent: v("--accent"), accentInk: v("--accent-ink"), accentContrast: v("--accent-contrast"),
    };
    return cachedColors;
  }

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
    const c = colors();
    const n = state.size, coords = state.coords !== false;
    const m = px * (coords ? 0.055 * Math.sqrt(19 / n) : 0.035);
    const cell = (px - 2 * m) / (n - 1);
    const X = (x) => m + x * cell, Y = (y) => m + y * cell;
    const stroke = (color, width) => (color ? ` stroke="${color}" stroke-width="${width}"` : "");
    const o = [];
    o.push(`<rect x="0" y="0" width="${px}" height="${px}" rx="${Math.max(4, px * 0.008)}" fill="${c.board}"/>`);
    for (let i = 0; i < n; i++) {
      const w = ((i === 0 || i === n - 1) ? 1.5 : 0.85) * Math.max(0.6, px / 800);
      o.push(`<line x1="${f1(m)}" y1="${f1(Y(i))}" x2="${f1(px - m)}" y2="${f1(Y(i))}" stroke="${c.grid}" stroke-width="${w.toFixed(2)}"/>`);
      o.push(`<line x1="${f1(X(i))}" y1="${f1(m)}" x2="${f1(X(i))}" y2="${f1(px - m)}" stroke="${c.grid}" stroke-width="${w.toFixed(2)}"/>`);
    }
    for (const [sx, sy] of starPoints(n)) {
      o.push(`<circle cx="${f1(X(sx))}" cy="${f1(Y(sy))}" r="${f1(cell * 0.09)}" fill="${c.grid}"/>`);
    }
    if (coords) {
      const fs = Math.min(cell * 0.36, 15);
      const t = (x, y, s) => `<text x="${f1(x)}" y="${f1(y)}" font-size="${f1(fs)}" text-anchor="middle" fill="${c.coord}" font-family="${MONO}">${s}</text>`;
      for (let i = 0; i < n; i++) {
        const letter = Go.LETTERS[i];
        o.push(t(X(i), m * 0.6, letter), t(X(i), px - m * 0.32, letter));
        o.push(t(m * 0.45, Y(i) + fs * 0.35, n - i), t(px - m * 0.45, Y(i) + fs * 0.35, n - i));
      }
    }

    // a territory or dead-stone mark in the owner's stone colour
    const mark = (x, y, black, opacity) => {
      const s = cell * 0.3;
      const edge = black ? stroke(c.bedge, 0.6) : stroke(c.wedge, 0.6);
      o.push(`<rect x="${f1(X(x) - s / 2)}" y="${f1(Y(y) - s / 2)}" width="${f1(s)}" height="${f1(s)}" rx="${f1(s * 0.15)}" fill="${black ? c.bstone : c.wstone}" fill-opacity="${opacity.toFixed(2)}"${edge}/>`);
    };

    const pos = state.position;
    const deadMarks = [];
    if (state.showTerritory && state.ownershipBlack) {
      for (let i = 0; i < n * n; i++) {
        const own = state.ownershipBlack[i], x = i % n, y = (i / n) | 0;
        const stone = pos.grid[i];
        if (stone) {
          if ((own > 0.5 && stone === Go.WHITE) || (own < -0.5 && stone === Go.BLACK)) deadMarks.push([x, y, own > 0]);
          continue;
        }
        if (Math.abs(own) >= 0.2) mark(x, y, own > 0, Math.min(0.7, Math.abs(own) * 0.75));
      }
    }

    if (state.policy) {
      const ranked = [];
      for (let i = 0; i < n * n; i++) if (state.policy[i] > 0.0005) ranked.push([i, state.policy[i]]);
      ranked.sort((a, b) => b[1] - a[1]);
      const labels = new Set(ranked.slice(0, 3).map((r) => r[0]));
      for (const [i, p] of ranked) {
        const x = i % n, y = (i / n) | 0, s = cell * 0.86;
        o.push(`<rect x="${f1(X(x) - s / 2)}" y="${f1(Y(y) - s / 2)}" width="${f1(s)}" height="${f1(s)}" rx="${f1(s * 0.18)}" fill="${c.accent}" fill-opacity="${Math.min(0.92, 0.1 + Math.sqrt(p) * 1.35).toFixed(2)}"/>`);
        if (labels.has(i)) o.push(`<text x="${f1(X(x))}" y="${f1(Y(y) + cell * 0.14)}" font-size="${f1(cell * 0.38)}" text-anchor="middle" fill="${c.accentContrast}" font-family="${MONO}" font-weight="500">${Math.round(p * 100)}</text>`);
      }
    }

    const r = cell * 0.47;
    const edgeWidth = Math.max(0.8, r * 0.06).toFixed(2);
    const stoneSvg = (x, y, black, opacity = 1) =>
      `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}" fill="${black ? c.bstone : c.wstone}"` +
      (opacity < 1 ? ` fill-opacity="${opacity}"` : "") +
      `${black ? stroke(c.bedge, edgeWidth) : stroke(c.wedge, edgeWidth)}/>`;
    for (let i = 0; i < n * n; i++) {
      const stone = pos.grid[i];
      if (!stone) continue;
      const x = X(i % n), y = Y((i / n) | 0);
      o.push(`<circle cx="${f1(x)}" cy="${f1(y + cell * 0.04)}" r="${f1(r)}" fill="#000" fill-opacity="0.16"/>`);
      o.push(stoneSvg(x, y, stone === Go.BLACK));
    }
    if (state.lastMove) {
      const { x, y } = state.lastMove, stone = pos.at(x, y);
      if (stone) o.push(`<circle cx="${f1(X(x))}" cy="${f1(Y(y))}" r="${f1(r * 0.42)}" fill="none" stroke="${stone === Go.BLACK ? c.wstone : c.bstone}" stroke-width="${f1(Math.max(1.2, cell * 0.05))}"/>`);
    }
    for (const [x, y, black] of deadMarks) mark(x, y, black, 1);

    const cands = state.candidates || [];
    const topVisits = Math.max(1, ...cands.map((cand) => cand.visits));
    for (const cand of cands) {
      let v;
      try { v = Go.fromGtp(cand.move, n); } catch (e) { v = null; }
      if (!v || pos.at(v.x, v.y)) continue;
      const x = X(v.x), y = Y(v.y), share = cand.visits / topVisits;
      let tcol;
      if (cand.order === 0) {
        o.push(`<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}" fill="${c.accent}"/>`);
        tcol = c.accentContrast;
      } else {
        // opaque base so the label stays readable over grid lines and territory marks
        o.push(`<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}" fill="${c.panel}"/>`);
        o.push(`<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}" fill="${c.accent}" fill-opacity="${(0.14 + 0.5 * share).toFixed(2)}" stroke="${c.accent}" stroke-width="1.2"/>`);
        tcol = share > 0.55 ? c.accentContrast : c.accentInk;
      }
      const hasLead = cand.scoreLead !== null && cand.scoreLead !== undefined;
      o.push(`<text x="${f1(x)}" y="${f1(y + (hasLead ? -cell * 0.02 : cell * 0.1))}" font-size="${f1(cell * 0.31)}" text-anchor="middle" fill="${tcol}" font-family="${MONO}" font-weight="500">${Math.round(cand.winrate * 100)}%</text>`);
      if (hasLead) o.push(`<text x="${f1(x)}" y="${f1(y + cell * 0.3)}" font-size="${f1(cell * 0.25)}" text-anchor="middle" fill="${tcol}" fill-opacity="0.9" font-family="${MONO}">${leadText(cand.scoreLead)}</text>`);
    }

    if (state.hover && !pos.at(state.hover.x, state.hover.y)) {
      o.push(stoneSvg(X(state.hover.x), Y(state.hover.y), state.toPlay === Go.BLACK, 0.45));
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
    const rounded = Math.round(v * 10) / 10;
    if (rounded === 0) return "0.0";
    return (rounded > 0 ? "+" : "−") + Math.abs(rounded).toFixed(1);
  }

  root.Board = { render, pointFromEvent, leadText };
})(this);
