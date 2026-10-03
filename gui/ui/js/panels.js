// Renders every panel of the front window from the app state (see app.js).
// Browser global window.Panels; depends on Go and Board.
(function (root) {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const colorName = (c) => (c === Go.BLACK ? "Black" : "White");
  const pct = (v, digits = 1) => (v * 100).toFixed(digits) + "%";
  const kfmt = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(v));
  const moveLabel = (m, size) => (m.vertex ? Go.toGtp(m.vertex.x, m.vertex.y, size) : "pass");

  function leadLabel(blackLead) {
    if (blackLead === null || blackLead === undefined) return "";
    const r = Math.round(blackLead * 10) / 10;
    return r === 0 ? "Even" : `${r > 0 ? "B" : "W"}+${Math.abs(r).toFixed(1)}`;
  }

  // handlers: { boardClick(point), hover(point|null), playMove(gtpVertex), goTo(index), goToNode(node) }
  function init(handlers) {
    const board = $("board");
    // Not "click": analysis redraws the board's contents several times a second,
    // and a click whose press and release hit different (replaced) elements is
    // never fired. Press and release on the same point play instead.
    let pressed = null;
    board.addEventListener("pointerdown", (e) => { pressed = e.button === 0 ? Board.pointFromEvent(board, e) : null; });
    board.addEventListener("pointerup", (e) => {
      const p = e.button === 0 && pressed ? Board.pointFromEvent(board, e) : null;
      if (p && p.x === pressed.x && p.y === pressed.y) handlers.boardClick(p);
      pressed = null;
    });
    board.addEventListener("mousemove", (e) => handlers.hover(Board.pointFromEvent(board, e)));
    board.addEventListener("mouseleave", () => { pressed = null; handlers.hover(null); });
    $("candidates").addEventListener("click", (e) => {
      const row = e.target.closest("[data-move]");
      if (row) handlers.playMove(row.dataset.move);
    });
    // pointerdown, not click: the tree is redrawn with every analysis update
    $("gt-inner").addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const inner = $("gt-inner"), ghost = e.target.closest(".ghost");
      if (ghost && inner._ghosts) {
        // a side curve: its move at the current move number, or its last move
        const g = inner._ghosts[+ghost.dataset.ghost];
        handlers.goToNode(g.path[Math.max(1, Math.min(inner._index - g.from, g.path.length - 1))]);
        return;
      }
      const row = e.target.closest(".gt-row[data-num]");
      if (row) handlers.goTo(parseInt(row.dataset.num, 10));
    });
  }

  function render(state) {
    const node = state.nodes[state.index];
    const hide = state.tab === "play";  // no engine hints while playing
    renderHeader(state, node);
    renderBoard(state);
    renderCandidates(state, node, hide);
    renderMainLine(node, hide);
    renderGameTree(state, hide);
    renderEvaluation(state, node, hide);
    renderPolicy(state, node, hide);
    renderEngineLine(state);
  }

  function renderHeader(state, node) {
    const kata = state.engine.kind === "katago";
    for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("active", b.dataset.tab === state.tab);
    for (const b of document.querySelectorAll("#size-picker button")) {
      const size = parseInt(b.dataset.size, 10);
      b.classList.toggle("active", size === state.size);
      b.disabled = !kata && size !== 19;
    }
    const caps = node.position.captures;
    $("game-info").textContent = `komi ${state.komi} · ${colorName(node.toPlay)} to play` +
      (caps[Go.BLACK] || caps[Go.WHITE] ? ` · captures ${caps[Go.BLACK]}–${caps[Go.WHITE]}` : "");
    const pill = $("analysis-toggle");
    const e = state.engine;
    pill.classList.toggle("paused", state.paused && !state.thinking);
    pill.classList.toggle("error", !!e.error);
    $("status-text").textContent = e.error ? "Engine error" : !e.ready ? "Starting engine"
      : state.thinking ? "Engine thinking" : state.review ? "Analyzing game" : state.paused ? "Paused" : "Analyzing";
    const a = node.analysis;
    $("status-visits").textContent = e.error ? "" : state.review ? `move ${state.index} of ${state.nodes.length - 1}`
      : a ? `${kfmt(a.visits)} visits` : "";
    const reviewButton = $("review-game");
    reviewButton.textContent = state.review ? "Stop game analysis" : "Analyze game";
    reviewButton.disabled = !e.ready || state.thinking || state.nodes.length < 2 || state.tab === "play";
    const territory = $("territory-toggle");
    territory.classList.toggle("on", state.showTerritory && kata);
    territory.disabled = !kata;
    $("engine-move").disabled = !e.ready || state.thinking;
    $("pass").disabled = state.thinking;
  }

  function renderBoard(state) {
    const node = state.nodes[state.index];
    const hide = state.tab === "play";
    const wrap = $("board-wrap");
    const px = Math.floor(Math.min(wrap.clientWidth, wrap.clientHeight));
    if (px < 120) return;
    const a = node.analysis;
    Board.render($("board"), px, {
      size: state.size,
      position: node.position,
      lastMove: node.move ? node.move.vertex : null,
      toPlay: node.toPlay,
      candidates: !hide && a ? a.candidates.slice(0, 8) : [],
      ownershipBlack: a ? a.ownershipBlack : null,
      showTerritory: state.showTerritory && !hide && state.engine.kind === "katago",
      hover: state.hover,
    });
  }

  function renderCandidates(state, node, hide) {
    const kata = state.engine.kind === "katago";
    const who = colorName(node.toPlay);
    $("cand-title").textContent = "Candidates · " + who;
    $("cand-note").textContent = kata ? `win · lead for ${who.toLowerCase()}` : `win for ${who.toLowerCase()}`;
    const cls = kata ? "cand-row" : "cand-row no-lead";
    let html = `<div class="${cls} head"><span></span><span>Move</span><span>Win</span>${kata ? "<span>Lead</span>" : ""}<span>Visits</span><span class="prior">Prior</span></div>`;
    const a = node.analysis;
    if (hide) {
      html += `<div class="muted small" style="padding: 10px 6px;">Hidden while you play.</div>`;
    } else if (a) {
      const top = Math.max(1, ...a.candidates.map((c) => c.visits));
      for (const c of a.candidates.slice(0, 8)) {
        html += `<div class="${cls} clickable" data-move="${c.move}" title="Play ${c.move}">` +
          `<span class="${c.order === 0 ? "best" : ""}"></span><span>${c.move}</span><span>${pct(c.winrate)}</span>` +
          (kata ? `<span>${Board.leadText(c.scoreLead)}</span>` : "") +
          `<div class="visits">${c.visits.toLocaleString("en-US")}<div class="bar"><div style="width: ${(100 * c.visits / top).toFixed(0)}%;"></div></div></div>` +
          `<span class="prior">${(c.prior * 100).toFixed(1)}</span></div>`;
      }
    }
    $("candidates").innerHTML = html;
  }

  function renderMainLine(node, hide) {
    const best = !hide && node.analysis ? node.analysis.candidates[0] : null;
    $("mainline-title").textContent = best ? `Main line · ${best.move}` : "Main line";
    $("mainline-visits").textContent = best ? `${best.visits.toLocaleString("en-US")} visits` : "";
    $("mainline").textContent = best ? best.pv.slice(0, 12).join(" ") : "";
  }

  function renderEvaluation(state, node, hide) {
    const a = hide ? null : node.analysis;
    $("eval-wr").textContent = a ? pct(a.blackWinrate) : "—";
    $("eval-lead").textContent = a ? leadLabel(a.blackLead) : "";
    $("stat-visits").textContent = a ? a.visits.toLocaleString("en-US") : "0";
    $("stat-speed").textContent = state.speed ? `${Math.round(state.speed)} v/s` : "—";
    $("stat-engine").textContent = state.engine.kind === "katago" ? "KataGo" : "Leela Zero";
  }

  function renderPolicy(state, node, hide) {
    const svg = $("policy");
    const px = Math.max(120, Math.min(300, svg.parentElement.clientWidth));
    let policy = null, note = "";
    if (!hide) {
      if (state.policy && state.policy.node === node) {
        policy = state.policy.policy;
        note = state.policy.pass !== null ? `pass ${(state.policy.pass * 100).toFixed(1)}%` : "";
      } else if (node.analysis) {
        // Leela Zero has no raw network command: use the priors from the search.
        policy = new Float32Array(state.size * state.size);
        for (const c of node.analysis.candidates) {
          try {
            const v = Go.fromGtp(c.move, state.size);
            if (v) policy[v.y * state.size + v.x] = c.prior;
          } catch (e) { /* pass or out of range */ }
        }
        note = "from search priors";
      }
    }
    $("policy-pass").textContent = note;
    Board.render(svg, px, {
      size: state.size, position: node.position, lastMove: node.move ? node.move.vertex : null,
      toPlay: node.toPlay, candidates: [], policy, coords: false,
    });
  }

  // ---- game tree ----
  // One row per move of the current line. Black's win rate after each move is
  // a vertical curve through the rows (left = White leads, right = Black), and
  // every variation that leaves the line is a faint side curve from its branch
  // point, clickable. Moves without analysis sit on the last known value.
  const ROW = 26, LANE_LEFT = 76, WR_COL = 58, LANE_PAD = 9;

  // The different moves played at move number `depth` anywhere in the tree,
  // first child first; lines that agree there count once.
  function movesAt(root, depth) {
    const out = [], stack = [[root, 0]];
    while (stack.length) {
      const [n, d] = stack.pop();
      if (d === depth) { out.push(n); continue; }
      for (let k = n.children.length - 1; k >= 0; k--) stack.push([n.children[k], d + 1]);
    }
    return out;
  }

  // a smooth curve through points (Catmull-Rom as cubic Béziers)
  function smooth(pts) {
    const f = (v) => v.toFixed(1);
    let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)},${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)},${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])},${f(p2[1])}`;
    }
    return d;
  }

  let treeScrollKey = "";
  function renderGameTree(state, hide) {
    const inner = $("gt-inner");
    const laneW = inner.clientWidth - LANE_LEFT - WR_COL;
    if (laneW < 40) return;  // left panel hidden
    const line = state.nodes, index = state.index, current = line[index];
    // Black's win rate after the move; while playing, not for the position on the board
    const wrOf = (n) => (n.analysis && !(hide && n === current) ? n.analysis.blackWinrate : null);
    const X = (wr) => LANE_PAD + wr * (laneW - 2 * LANE_PAD);
    const Y = (i) => (i === 0 ? 0 : (i - 0.5) * ROW);
    const wrs = line.map(wrOf);
    let last = wrs[0] === null ? 0.5 : wrs[0];
    const pts = wrs.map((w, i) => { if (w !== null) last = w; return [X(last), Y(i)]; });
    // win rate the mover gave away (> 0 = worse for the player who moved)
    const lost = (i) => (wrs[i] === null || wrs[i - 1] === null ? 0
      : line[i].move.color === Go.BLACK ? wrs[i - 1] - wrs[i] : wrs[i] - wrs[i - 1]);

    // every variation leaving the line, followed along its remembered line
    const ghosts = [];
    let rows = line.length - 1;
    for (let i = 0; i < line.length - 1; i++) {
      for (const alt of line[i].children) {
        if (alt === line[i + 1]) continue;
        const path = [line[i]];
        for (let a = alt; a; a = a.next || a.children[0]) path.push(a);
        ghosts.push({ from: i, path });
        rows = Math.max(rows, i + path.length - 1);
      }
    }
    const H = rows * ROW + 8;

    const o = [`<line class="mid" x1="${X(0.5)}" y1="0" x2="${X(0.5)}" y2="${H}"/>`];
    // shade between the curve and 50 %, over each run of analysed moves
    for (let i = 0; i < line.length;) {
      let j = i;
      while (j < line.length && wrs[j] !== null) j++;
      if (j - i > 1) {
        const run = pts.slice(i, j);
        o.push(`<path class="tint" d="${smooth(run)} L${X(0.5)},${run[run.length - 1][1]} L${X(0.5)},${run[0][1]} Z"/>`);
      }
      i = j + 1;
    }

    ghosts.forEach((g, k) => {
      let lk = pts[g.from][0];
      const gp = g.path.map((n, j) => {
        const w = j ? wrOf(n) : null;
        if (w !== null) lk = X(w);
        return [lk, Y(g.from + j)];
      });
      const d = smooth(gp), tip = gp[gp.length - 1], end = g.from + g.path.length - 1, alt = g.path[1].move;
      const label = `${alt.color === Go.BLACK ? "B" : "W"} ${moveLabel(alt, state.size)} … ${end}`;
      const right = tip[0] >= pts[Math.min(end, pts.length - 1)][0];  // label on the side away from the line
      o.push(`<g class="ghost" data-ghost="${k}"><title>${label} (${g.path.length - 1} moves)</title><path class="hit" d="${d}"/><path class="vine" d="${d}"/>`);
      gp.forEach((p, j) => { if (j) o.push(`<circle class="${g.path[j].move.color === Go.BLACK ? "stone-b" : "stone-w"}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.6"/>`); });
      o.push(`<text x="${(tip[0] + (right ? 8 : -8)).toFixed(1)}" y="${(tip[1] + 14).toFixed(1)}" text-anchor="${right ? "start" : "end"}">${label}</text></g>`);
    });

    // the line: solid between analysed moves, dotted where analysis is missing
    for (let i = 0; i < line.length - 1;) {
      const solid = wrs[i + 1] !== null && (i === 0 || wrs[i] !== null);
      let j = i + 1;
      while (j < line.length - 1 && (wrs[j + 1] !== null && wrs[j] !== null) === solid) j++;
      o.push(`<path class="trunk${solid ? "" : " pending"}" d="${smooth(pts.slice(i, j + 1))}"/>`);
      i = j;
    }
    for (let i = 1; i < line.length; i++) {
      const [x, y] = pts[i], r = i === index ? 5.5 : 4;
      const cls = wrs[i] === null ? "hollow" : line[i].move.color === Go.BLACK ? "stone-b" : "stone-w";
      if (lost(i) > 0.1) o.push(`<circle class="swing" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r + 3}"/>`);
      o.push(`<circle class="${cls}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}"/>`);
      if (i === index) o.push(`<circle class="now" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r + 3.5}"/>`);
    }

    const html = [`<svg class="gt-lane" width="${laneW}" height="${H}" viewBox="0 0 ${laneW} ${H}">${o.join("")}</svg>`];
    for (let i = 1; i <= rows; i++) {
      const n = line[i];
      if (!n) { html.push(`<div class="gt-row spacer"></div>`); continue; }  // a side curve runs on
      const l = lost(i);
      const delta = l > 0.05 ? `<span class="d${l > 0.1 ? " bad" : ""}">−${Math.round(l * 100)}</span>` : "";
      const cls = ["gt-row", i === index && "current", n.parent.children.length > 1 && "branch", wrs[i] === null && "pending"].filter(Boolean).join(" ");
      html.push(`<div class="${cls}" data-num="${i}"><span class="num">${i}</span><span>${n.move.color === Go.BLACK ? "B" : "W"} ${moveLabel(n.move, state.size)}</span><span></span>` +
        `<span class="wr">${wrs[i] === null ? "—" : Math.round(wrs[i] * 100)}${delta}</span></div>`);
    }
    inner.innerHTML = html.join("");
    inner.style.height = H + "px";
    inner._ghosts = ghosts;
    inner._index = index;

    // keep the current move in view (only when it changed, so manual scrolling sticks)
    const key = `${current.id}|${line.length}`;
    if (key !== treeScrollKey) {
      treeScrollKey = key;
      const box = $("game-tree"), top = (index - 1) * ROW, h = box.clientHeight;
      if (top < box.scrollTop + 30 || top > box.scrollTop + h - 60) box.scrollTop = top - h / 2;
    }
    const here = movesAt(state.root, index);
    $("gt-status").innerHTML = `<b>${index}</b> / ${line.length - 1}` +
      (here.length > 1 ? ` · move <b>${here.indexOf(current) + 1}</b> of ${here.length} here` : "");
  }

  function renderEngineLine(state) {
    const e = state.engine;
    const parts = [e.version, e.network, e.backend].filter(Boolean).map((s) => `<span>${escapeHtml(s)}</span>`);
    if (e.error) parts.push(`<span class="warn">${escapeHtml(e.error)}</span>`);
    $("engine-line").innerHTML = parts.join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  root.Panels = { init, render, renderBoard, leadLabel, movesAt };
})(this);
