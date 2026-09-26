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

  // handlers: { boardClick(point), hover(point|null), playMove(gtpVertex), goTo(index) }
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
    $("record").addEventListener("click", (e) => {
      const cell = e.target.closest("[data-index]");
      if (cell) handlers.goTo(parseInt(cell.dataset.index, 10));
    });
    $("winrate-graph").addEventListener("click", (e) => {
      const g = $("winrate-graph")._graph;
      if (!g) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const i = Math.round(((e.clientX - rect.left) - g.padL) / (g.w - g.padL - g.padR) * g.n);
      handlers.goTo(Math.max(0, Math.min(g.n, i)));
    });
  }

  function render(state) {
    const node = state.nodes[state.index];
    const hide = state.tab === "play";  // no engine hints while playing
    renderHeader(state, node);
    renderBoard(state);
    renderCandidates(state, node, hide);
    renderMainLine(node, hide);
    renderRecord(state);
    renderEvaluation(state, node, hide);
    renderPolicy(state, node, hide);
    renderVariations(state, node, hide);
    renderGraph(state, hide);
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

  let lastRecordIndex = -1;
  function renderRecord(state) {
    const nodes = state.nodes;
    let html = `<div class="record-row head"><span>#</span><span>Black</span><span>White</span></div>`;
    for (let k = 1; k < nodes.length; k += 2) {
      html += `<div class="record-row"><span class="muted">${(k + 1) / 2}</span>`;
      for (const i of [k, k + 1]) {
        if (i >= nodes.length) { html += "<span></span>"; continue; }
        const a = nodes[i].analysis;
        const wr = a ? Math.round(a.blackWinrate * 100) : "";
        html += `<span class="record-move${i === state.index ? " current" : ""}" data-index="${i}"><span>${moveLabel(nodes[i].move, state.size)}</span><span class="wr">${wr}</span></span>`;
      }
      html += "</div>";
    }
    const box = $("record");
    box.innerHTML = html;
    if (state.index !== lastRecordIndex) {
      lastRecordIndex = state.index;
      const cur = box.querySelector(".current");
      if (cur) cur.scrollIntoView({ block: "nearest" });
    }
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
      if (state.policy && state.policy.index === state.index) {
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

  function renderVariations(state, node, hide) {
    const items = [];
    const game = state.nodes.slice(1, state.index + 1).map((n) => moveLabel(n.move, state.size));
    items.push({ title: "Game", moves: game.slice(-8), active: true });
    const a = hide ? null : node.analysis;
    if (a && a.candidates.length) {
      const name = state.engine.kind === "katago" ? "KataGo" : "Leela Zero";
      const best = a.candidates[0];
      items.push({ title: `${name} best · ${best.move}`, moves: best.pv.slice(0, 9) });
      const most = a.candidates.reduce((x, y) => (y.visits > x.visits ? y : x));
      if (most.move !== best.move) items.push({ title: `Most visited · ${most.move}`, moves: most.pv.slice(0, 9) });
    }
    $("variations").innerHTML = items.map((v) =>
      `<div class="variation${v.active ? " active" : ""}"><span class="title">${v.title}</span><span class="moves">${v.moves.join(" ") || "—"}</span></div>`).join("");
  }

  function renderGraph(state, hide) {
    const svg = $("winrate-graph");
    const w = Math.max(200, svg.clientWidth), h = Math.max(48, svg.clientHeight || 72);
    const padL = 8, padR = 8, padT = 10, padB = 24;
    const n = Math.max(1, state.nodes.length - 1);
    const vals = state.nodes.map((nd) => (nd.analysis && !(hide && nd === state.nodes[state.index]) ? nd.analysis.blackWinrate * 100 : null));
    const known = vals.filter((v) => v !== null);
    const spread = Math.max(6, ...known.map((v) => Math.abs(v - 50) * 1.25));
    const lo = 50 - spread, hi = 50 + spread;
    const X = (i) => padL + (w - padL - padR) * i / n;
    const Y = (v) => padT + (h - padT - padB) * (hi - v) / (hi - lo);
    const o = [`<line x1="${padL}" y1="${Y(50).toFixed(1)}" x2="${w - padR}" y2="${Y(50).toFixed(1)}" stroke="var(--muted)" stroke-opacity="0.5"/>`];
    // one polyline per run of analysed moves
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        const pts = run.map(([i, v]) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
        o.push(`<path d="M${X(run[0][0]).toFixed(1)},${Y(50).toFixed(1)} L${pts.replace(/ /g, " L")} L${X(run[run.length - 1][0]).toFixed(1)},${Y(50).toFixed(1)} Z" fill="var(--ink)" fill-opacity="0.07"/>`);
        o.push(`<polyline points="${pts}" fill="none" stroke="var(--ink)" stroke-width="1.6" stroke-linejoin="round"/>`);
      }
      run = [];
    };
    vals.forEach((v, i) => (v === null ? flush() : run.push([i, v])));
    flush();
    const step = Math.ceil(n / 20);
    for (let i = 0; i <= n; i += step) {
      o.push(`<line x1="${X(i).toFixed(1)}" y1="${h - padB + 4}" x2="${X(i).toFixed(1)}" y2="${h - padB + 8}" stroke="var(--muted)"/>`);
      o.push(`<text x="${X(i).toFixed(1)}" y="${h - 6}" font-size="11" text-anchor="middle" fill="var(--muted)" font-family="var(--mono)">${i}</text>`);
    }
    const cx = X(state.index);
    o.push(`<line x1="${cx.toFixed(1)}" y1="${padT - 4}" x2="${cx.toFixed(1)}" y2="${h - padB}" stroke="var(--accent)" stroke-width="1.5"/>`);
    if (vals[state.index] !== null) o.push(`<circle cx="${cx.toFixed(1)}" cy="${Y(vals[state.index]).toFixed(1)}" r="4" fill="var(--accent)"/>`);
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.innerHTML = o.join("");
    svg._graph = { padL, padR, n, w };
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

  root.Panels = { init, render, renderBoard, leadLabel };
})(this);
