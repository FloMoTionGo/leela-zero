// Front window logic: game state, engine control, settings, SGF and self test.
// Depends on Go, Gtp, Board and Panels. Talks to the host through
// window.chrome.webview (see gui/host/main.cpp for the message format).
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const DEFAULTS = { engine: "katago", komi: 7.5, human: 1, visits: 400, threads: 8, dark: false,
                     hideLeft: false, hideRight: false };
  const PROFILES = {
    katago: {
      name: "KataGo", sizes: [9, 13, 19], dir: "katago", protocol: "katago",
      network: "kata1-tf2-b10c384", backend: "GPU · OpenCL",
      // Analysis ignores maxVisits; it only limits genmove. A max batch of half the
      // search threads measured fastest on an RTX A2000 (KataGo benchmark).
      cmd: (dir, s) => `"${dir}\\katago.exe" gtp -model tf2-b10c384.bin.gz -config gtp_opencl.cfg -override-config ` +
        `numSearchThreads=${s.threads},nnMaxBatchSize=${Math.ceil(s.threads / 2)},` +
        `reportAnalysisWinratesAs=SIDETOMOVE,ponderingEnabled=false,maxVisits=${s.visits}`,
      analyze: "kata-analyze interval 25 ownership true",
      beforeGenmove: (s) => `kata-set-param maxVisits ${s.visits}`,
      afterGenmove: null,
    },
    leelaz: {
      name: "Leela Zero", sizes: [19], dir: "leelaz", protocol: "leelaz",
      network: "leelaz 40 blocks × 256", backend: "OpenCL",
      // Leela Zero's analysis stops at the visit limit, so it runs unlimited
      // and the limit is set only around genmove.
      cmd: (dir, s) => `"${dir}\\leelaz.exe" -g --noponder -t ${s.threads} -w best-network`,
      analyze: "lz-analyze 25",
      beforeGenmove: (s) => `lz-setoption name visits value ${s.visits}`,
      afterGenmove: "lz-setoption name visits value 0",
    },
    // For PCs without an OpenCL GPU: small network on the CPU.
    "leelaz-cpu": {
      name: "Leela Zero", sizes: [19], dir: "leelaz", protocol: "leelaz",
      network: "leelaz 6 blocks × 128", backend: "CPU · OpenBLAS",
      cmd: (dir, s) => `"${dir}\\leelaz.exe" -g --noponder --cpu-only -t ${s.threads} -w networks\\leelaz-6b-fast.gz`,
      analyze: "lz-analyze 25",
      beforeGenmove: (s) => `lz-setoption name visits value ${s.visits}`,
      afterGenmove: "lz-setoption name visits value 0",
    },
  };

  const state = {
    size: 19, komi: DEFAULTS.komi, tab: "review", setup: [],
    engine: { kind: "katago", ready: false, version: "", network: "", backend: "", error: "" },
    nodes: [], index: 0, paused: true,  // analysis starts on request (Space or the status pill)
    thinking: false, speed: null,
    root: null, treeVersion: 0,  // see "game tree" below
    showTerritory: false, policy: null, hover: null, resigned: null,
    review: null,  // {visits} while "Analyze game" steps through the moves
  };
  let settings = { ...DEFAULTS };
  let savePath = "";  // file chosen at the last save; Save writes there without asking
  let exeDir = "", engine = null, engineSerial = 0, engineMoves = null, stderrTail = [];

  const send = (...fields) => window.chrome.webview.postMessage(fields.join("\t"));
  const current = () => state.nodes[state.index];

  // ---------------- rendering and messages ----------------
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued || !state.nodes.length) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; Panels.render(state); });
  }

  let toastTimer = null;
  function toast(text) {
    const t = $("toast");
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
  }

  // ---------------- game tree ----------------
  // Every node keeps its children (variations, first = main line) and `next`,
  // the child last visited. state.nodes is the current line: root to the shown
  // node, then on through `next` to the end, so the record, graph and arrow
  // keys all follow the branch being looked at. state.treeVersion changes
  // whenever a node is added, for the move tree panel.
  let nodeSerial = 0;
  function makeNode(parent, position, move, toPlay) {
    const node = { id: ++nodeSerial, parent, children: [], next: null, position, move, toPlay, analysis: null };
    if (parent) { parent.children.push(node); state.treeVersion++; }
    return node;
  }

  // Shows `node`, making its line the current one.
  function showNode(node) {
    const path = [];
    for (let n = node; n; n = n.parent) path.unshift(n);
    for (let k = 1; k < path.length; k++) path[k - 1].next = path[k];
    state.index = path.length - 1;
    for (let n = node.next; n; n = n.next) path.push(n);
    state.nodes = path;
    state.root = path[0];
  }

  // Plays `move` after `node`: an existing child with that move is reused, so
  // replaying a move follows its branch instead of adding a copy.
  function addMove(node, move, position) {
    return node.children.find((c) => sameMove(c.move, move)) ||
      makeNode(node, position || node.position.play(move.color, move.vertex), move, Go.other(move.color));
  }

  // tree: list of branches { move, children } as Go.parseSgf returns them.
  function newGame(size, setup = [], tree = []) {
    savePath = "";  // a new or opened game must not overwrite the last saved file
    state.size = size;
    state.setup = setup;
    state.policy = null;
    state.resigned = null;
    state.treeVersion++;
    const position = new Go.Position(size);
    for (const s of setup) position.grid[s.vertex.y * size + s.vertex.x] = s.color;
    const handicap = setup.length > 0 && setup.every((s) => s.color === Go.BLACK);
    const root = makeNode(null, position, null, handicap ? Go.WHITE : Go.BLACK);
    let illegal = 0;
    const grow = (parent, branches) => {
      for (const b of branches) {
        const next = parent.position.play(b.move.color, b.move.vertex);
        if (!next) { illegal++; continue; }
        grow(addMove(parent, b.move, next), b.children);
      }
    };
    grow(root, tree);
    if (illegal) toast(`${illegal} illegal move${illegal > 1 ? "s" : ""} in the file; the line${illegal > 1 ? "s stop" : " stops"} there.`);
    let end = root;
    while (end.children.length) end = end.children[0];
    showNode(end);
    positionChanged();
  }

  const chain = (moves) => moves.reduceRight((children, move) => [{ move, children }], []);

  function positionChanged() {
    state.policy = null;
    scheduleRender();
    requestSync();
  }

  function tryPlay(vertex) {
    state.review = null;
    const node = current();
    if (state.thinking || gameOver()) return;
    if (state.tab === "play" && node.toPlay !== settings.human) return;
    const move = { color: node.toPlay, vertex };
    const existing = node.children.find((c) => sameMove(c.move, move));
    const next = existing ? existing.position : node.position.play(move.color, vertex);
    if (!next) { toast("Illegal move"); return; }
    showNode(addMove(node, move, next));
    positionChanged();
  }

  function goTo(i) {
    if (selftestTrace) selftestTrace.push(`goTo(${i}) from index ${state.index}: ${(new Error().stack || "").split("\n").slice(2, 4).join(" | ")}`);
    if (state.thinking) return;
    state.review = null;  // navigating by hand ends "Analyze game"
    i = Math.max(0, Math.min(state.nodes.length - 1, i));
    if (i === state.index) return;
    state.index = i;
    positionChanged();
  }

  // Jumps to any node of the tree (move tree panel).
  function goToNode(node) {
    if (state.thinking || node === current()) return;
    state.review = null;
    showNode(node);
    positionChanged();
  }

  // Up/down: the previous or next variation at the closest branch point above.
  function switchBranch(step) {
    if (state.thinking) return;
    for (let n = current(); n.parent; n = n.parent) {
      const siblings = n.parent.children;
      if (siblings.length < 2) continue;
      const k = siblings.indexOf(n) + step;
      if (k < 0 || k >= siblings.length) return;
      let target = siblings[k];
      // keep the same depth where that branch reaches it
      for (let d = state.index - (state.nodes.indexOf(n)); d > 0 && (target.next || target.children[0]); d--) target = target.next || target.children[0];
      goToNode(target);
      return;
    }
  }

  function gameOver() {
    const n = state.nodes, i = state.index;
    const passes = i >= 2 && n[i].move.vertex === null && n[i - 1].move.vertex === null;
    return passes || state.resigned === n[i];
  }

  // ---------------- engine ----------------
  function startEngine() {
    if (engine) engine.stop();
    const kind = settings.engine, prof = PROFILES[kind];
    const dir = `${exeDir}\\engines\\${prof.dir}`;
    state.engine = { kind, ready: false, version: "", network: prof.network, backend: prof.backend, error: "" };
    state.speed = null;
    state.thinking = false;
    engineMoves = null;
    stderrTail = [];
    engine = new Gtp.Engine(`engine${++engineSerial}`, prof.protocol, { send });
    engine.onStderr = (text) => {
      stderrTail.push(text);
      if (stderrTail.length > 20) stderrTail.shift();
      const device = /Selected device: (.*)/.exec(text);
      if (device) { state.engine.backend = "OpenCL · " + device[1].trim(); scheduleRender(); }
    };
    engine.start(dir, prof.cmd(dir, settings));
    scheduleRender();
  }

  async function engineStarted() {
    try {
      const name = await engine.command("name");
      const version = await engine.command("version");
      state.engine.version = `${name} ${version}`.trim();
      state.engine.ready = true;
      const prof = PROFILES[state.engine.kind];
      if (prof.afterGenmove) await engine.command(prof.afterGenmove);
    } catch (e) {
      state.engine.error = e.message;
    }
    scheduleRender();
    requestSync();
  }

  // Brings the engine to the shown position, then analyses or moves.
  // Runs one sync at a time; a request during a sync starts another pass.
  let syncRunning = false, syncAgain = false, wantEngineMove = false;
  function requestSync() {
    syncAgain = true;
    if (!syncRunning) runSync();
  }

  async function runSync() {
    syncRunning = true;
    while (syncAgain) {
      syncAgain = false;
      try {
        await syncOnce();
      } catch (e) {
        engineMoves = null;
        if (state.engine.ready) toast(e.message);
      }
    }
    syncRunning = false;
  }

  const sameMove = (a, b) => a.color === b.color &&
    (a.vertex === null || b.vertex === null ? a.vertex === b.vertex : a.vertex.x === b.vertex.x && a.vertex.y === b.vertex.y);
  const gtpMove = (m) => `${m.color === Go.BLACK ? "b" : "w"} ${m.vertex ? Go.toGtp(m.vertex.x, m.vertex.y, state.size) : "pass"}`;

  async function syncOnce() {
    if (!engine || !state.engine.ready) return;
    const target = state.nodes.slice(1, state.index + 1).map((n) => n.move);
    const setupKey = JSON.stringify(state.setup);
    let em = engineMoves;
    if (em && em.size === state.size && em.komi === state.komi && em.setupKey === setupKey) {
      let common = 0;
      while (common < em.moves.length && common < target.length && sameMove(em.moves[common], target[common])) common++;
      const undos = em.moves.length - common;
      if (undos > 20) {
        em = null;
      } else {
        for (let i = 0; i < undos; i++) { await engine.command("undo"); em.moves.pop(); }
      }
    } else {
      em = null;
    }
    if (!em) {
      engineMoves = null;
      await engine.command(`boardsize ${state.size}`);
      await engine.command("clear_board");
      await engine.command(`komi ${state.komi}`);
      const handicap = state.setup.filter((s) => s.color === Go.BLACK);
      if (handicap.length) {
        await engine.command("set_free_handicap " + handicap.map((s) => Go.toGtp(s.vertex.x, s.vertex.y, state.size)).join(" "));
      }
      em = engineMoves = { size: state.size, komi: state.komi, setupKey, moves: [] };
    }
    for (let i = em.moves.length; i < target.length; i++) {
      if (syncAgain) return;
      await engine.command("play " + gtpMove(target[i]));
      em.moves.push(target[i]);
    }
    if (syncAgain) return;

    const shown = current();
    if (state.engine.kind === "katago" && !(state.policy && state.policy.node === shown)) {
      try {
        const raw = await engine.command("kata-raw-nn 0");
        if (!syncAgain && current() === shown) {
          state.policy = { node: shown, ...Gtp.parseRawNn(raw.split("\n"), state.size) };
          scheduleRender();
        }
      } catch (e) { /* policy panel falls back to search priors */ }
    }
    if (syncAgain) return;

    const engineTurn = state.tab === "play" && current().toPlay !== settings.human;
    if ((wantEngineMove || engineTurn) && !gameOver()) {
      wantEngineMove = false;
      await engineMove();
      return;
    }
    wantEngineMove = false;
    if (!state.paused) startAnalysis(shown);
  }

  async function engineMove() {
    const node = current(), color = node.toPlay;
    const prof = PROFILES[state.engine.kind];
    state.thinking = true;
    scheduleRender();
    try {
      await engine.command(prof.beforeGenmove(settings));
      const reply = (await engine.command(`genmove ${color === Go.BLACK ? "b" : "w"}`)).trim();
      if (prof.afterGenmove) await engine.command(prof.afterGenmove);
      if (/^resign$/i.test(reply)) {
        state.resigned = node;
        toast(`${prof.name} resigns`);
        return;
      }
      const vertex = Go.fromGtp(reply, state.size);
      const move = { color, vertex };
      const next = node.position.play(color, vertex);
      if (!next || current() !== node) { engineMoves = null; return; }
      showNode(addMove(node, move, next));
      engineMoves.moves.push(move);
      state.policy = null;
    } finally {
      state.thinking = false;
      scheduleRender();
      syncAgain = true;  // the running sync loop continues with the new position
    }
  }

  function startAnalysis(node) {
    let last = null;
    engine.analyze(PROFILES[state.engine.kind].analyze, (info) => {
      if (current() !== node || !info.candidates.length) return;
      node.analysis = normalize(info, node.toPlay);
      const now = performance.now();
      if (last && now > last.t) {
        const rate = (node.analysis.visits - last.visits) * 1000 / (now - last.t);
        if (rate > 0) state.speed = state.speed ? state.speed * 0.8 + rate * 0.2 : rate;
      }
      last = { visits: node.analysis.visits, t: now };
      scheduleRender();
      if (state.review && node.analysis.visits >= state.review.visits) advanceReview();
    }).catch(() => { /* interrupted or engine gone */ });
  }

  // Engine output is from the side to move; panels also need Black's view.
  function normalize(info, toPlay) {
    const best = info.candidates[0];
    const sign = toPlay === Go.BLACK ? 1 : -1;
    return {
      candidates: info.candidates,
      visits: info.candidates.reduce((sum, c) => sum + c.visits, 0),
      blackWinrate: toPlay === Go.BLACK ? best.winrate : 1 - best.winrate,
      blackLead: best.scoreLead === null ? null : sign * best.scoreLead,
      ownershipBlack: info.ownership ? info.ownership.map((v) => v * sign) : null,
    };
  }

  // Light (creamy) or dark (charcoal) scheme, as in GoSequencer: one switch in
  // the header (sun or moon, see style.css), remembered in the settings.
  function applyScheme(dark) {
    document.documentElement.dataset.scheme = dark ? "dark" : "light";
    const toggle = $("scheme-toggle");
    toggle.setAttribute("aria-pressed", String(dark));
    toggle.title = dark ? "Switch to light mode" : "Switch to dark mode";
    send("theme", dark ? "dark" : "light");  // title bar and window background
    scheduleRender();                         // the board reads its colours from the scheme
  }

  function toggleScheme() {
    settings.dark = !settings.dark;
    applyScheme(settings.dark);
    send("save-settings", JSON.stringify(settings));
  }

  // Side panels: hidden ones give the board their width, remembered in the settings.
  function applyPanes() {
    const app = $("app");
    app.classList.toggle("hide-left", settings.hideLeft);
    app.classList.toggle("hide-right", settings.hideRight);
    for (const [id, hidden, side] of [["toggle-left", settings.hideLeft, "left"], ["toggle-right", settings.hideRight, "right"]]) {
      $(id).setAttribute("aria-pressed", String(hidden));
      $(id).title = `${hidden ? "Show" : "Hide"} the ${side} panel`;
    }
    scheduleRender();  // the board sizes itself to its new space
  }

  function togglePane(key) {
    settings[key] = !settings[key];
    applyPanes();
    send("save-settings", JSON.stringify(settings));
  }

  function togglePause() {
    state.paused = !state.paused;
    if (state.paused) {
      if (engine && state.engine.ready) engine.command("name").catch(() => {});  // any command ends analysis
    } else {
      requestSync();
    }
    scheduleRender();
  }

  // ---------------- analyse every move ----------------
  function toggleReview() {
    if (state.review) { state.review = null; scheduleRender(); return; }
    if (!state.engine.ready || state.nodes.length < 2 || state.tab === "play") return;
    state.review = { visits: state.engine.kind === "katago" ? 60 : 120 };
    state.paused = false;
    state.index = -1;  // advanceReview starts at move 0 and skips analysed moves
    advanceReview();
  }

  function advanceReview() {
    const target = state.review.visits;
    let i = state.index + 1;
    while (i < state.nodes.length && state.nodes[i].analysis && state.nodes[i].analysis.visits >= target) i++;
    if (i >= state.nodes.length) {
      state.review = null;
      state.index = state.nodes.length - 1;
      toast("Every move is analysed");
    } else {
      state.index = i;
    }
    positionChanged();
  }

  // ---------------- files and settings ----------------
  function loadSgf(content) {
    let game;
    try { game = Go.parseSgf(content); } catch (e) { toast("Could not read the SGF file: " + e.message); return; }
    const prof = PROFILES[state.engine.kind];
    if (!prof.sizes.includes(game.size)) { toast(`${prof.name} cannot analyse ${game.size}×${game.size}`); return; }
    const setup = game.setup.filter((s) => s.vertex);
    if (setup.some((s) => s.color === Go.WHITE)) toast("White setup stones are shown but not sent to the engine.");
    state.komi = game.komi;
    state.tab = "review";
    newGame(game.size, setup, game.tree);
  }

  // Save asks for a file only the first time (or with Save as); later saves
  // go straight to that file. Every variation is saved; the line being looked
  // at goes first, so it is the main line that opens when the file is loaded.
  function saveSgf(ask) {
    const onLine = new Set(state.nodes);
    const ordered = (list) => [...list].sort((a, b) => onLine.has(b) - onLine.has(a))
      .map((n) => ({ move: n.move, children: ordered(n.children) }));
    const game = { size: state.size, komi: state.komi, black: "", white: "", setup: state.setup, tree: ordered(state.root.children) };
    if (savePath && !ask) send("save-sgf-to", savePath, Go.writeSgf(game));
    else send("save-sgf", savePath || `game-${new Date().toISOString().slice(0, 10)}.sgf`, Go.writeSgf(game));
  }

  function showSavePath() {
    const name = savePath.split("\\").pop();
    $("save-sgf").textContent = savePath ? `Save ${name}` : "Save SGF…";
    $("save-sgf").title = savePath ? `Save to ${savePath}` : "Choose a file and save";
  }

  function openSettings() {
    $("set-engine").value = settings.engine;
    $("set-komi").value = state.komi;
    $("set-human").value = settings.human;
    $("set-visits").value = settings.visits;
    $("set-threads").value = settings.threads;
    $("settings").showModal();
  }

  function applySettings() {
    const next = {
      engine: $("set-engine").value,
      komi: parseFloat($("set-komi").value) || 7.5,
      human: parseInt($("set-human").value, 10),
      visits: Math.max(1, parseInt($("set-visits").value, 10) || DEFAULTS.visits),
      threads: Math.max(1, parseInt($("set-threads").value, 10) || DEFAULTS.threads),
      dark: settings.dark,  // set by the Dark switch, not in this dialog
      hideLeft: settings.hideLeft, hideRight: settings.hideRight,  // set by the panel buttons
    };
    const restart = next.engine !== settings.engine || next.threads !== settings.threads;
    const komiChanged = next.komi !== state.komi;
    settings = next;
    state.komi = next.komi;
    send("save-settings", JSON.stringify(settings));
    if (restart) {
      startEngine();
      if (!PROFILES[next.engine].sizes.includes(state.size)) { newGame(19); return; }
    }
    if (komiChanged) positionChanged();
    else requestSync();  // your colour may have changed whose turn it is
  }

  // ---------------- self test ----------------
  // Plays a fixed 19x19 opening and reports "ready" once analysis and policy
  // are shown, so the host can capture the window.
  let selftestTrace = null;  // navigation calls during a self test, shown if any happen
  // Scenarios: "" (KataGo 19x19), "kata9" (KataGo 9x9, territory on), "leelaz19".
  function runSelftest(scenario) {
    const nine = scenario === "kata9";
    const opening = nine ? ["E5", "C4", "F3", "D6", "G5", "C6", "E7"]
      : ["Q16", "D4", "Q3", "D16", "R5", "C10", "O17", "F17", "C3", "D3", "C4", "D5", "B6"];
    const size = nine ? 9 : 19;
    if (nine) { state.komi = 7; state.showTerritory = true; }
    newGame(size, [], chain(opening.map((v, i) => ({ color: i % 2 ? Go.WHITE : Go.BLACK, vertex: Go.fromGtp(v, size) }))));
    selftestTrace = [];
    const started = performance.now();
    let reviewStarted = false;
    const timer = setInterval(() => {
      const a = current().analysis;
      const needPolicy = state.engine.kind === "katago";  // Leela Zero has no raw policy
      if (scenario === "review19" && !reviewStarted && state.engine.ready) { reviewStarted = true; toggleReview(); }
      const done = scenario === "review19"
        ? reviewStarted && !state.review && a && a.visits >= 60
        : a && a.visits >= 300 && (!needPolicy || state.policy);
      if (done || performance.now() - started > 120000 || state.engine.error) {
        clearInterval(timer);
        if (selftestTrace.length) {
          const box = document.body.appendChild(document.createElement("pre"));
          box.style.cssText = "position:fixed;left:16px;right:16px;top:80px;margin:0;padding:12px;background:#221f1b;color:#fff;font:13px Consolas,monospace;white-space:pre-wrap;z-index:9";
          box.textContent = "Navigation during self test:\n" + selftestTrace.join("\n");
        }
        Panels.render(state);
        requestAnimationFrame(() => requestAnimationFrame(() => send("ready")));
      }
    }, 500);
  }

  // ---------------- wiring ----------------
  window.chrome.webview.addEventListener("message", (event) => {
    const m = event.data;
    switch (m.type) {
      case "hello": {
        exeDir = m.exeDir;
        if (!m.selftest && m.settings) {
          try { settings = { ...DEFAULTS, ...JSON.parse(m.settings) }; } catch (e) { /* keep defaults */ }
        }
        if (!PROFILES[settings.engine]) settings.engine = DEFAULTS.engine;  // settings from another version
        let scenario = m.scenario || "";
        if (m.selftest && scenario.endsWith("-dark")) { settings.dark = true; scenario = scenario.slice(0, -5); }
        if (m.selftest && scenario === "leelaz19") settings.engine = "leelaz";
        if (m.selftest) state.paused = false;  // the capture needs analysis
        applyScheme(settings.dark);
        applyPanes();
        state.komi = settings.komi;
        newGame(19);
        startEngine();
        if (m.selftest) runSelftest(scenario);
        break;
      }
      case "started":
        if (!engine || m.id !== engine.id) break;
        if (m.ok) engineStarted();
        else { state.engine.error = `Could not start ${PROFILES[state.engine.kind].name}: ${m.error}`; scheduleRender(); }
        break;
      case "line":
        if (engine && m.id === engine.id) engine.onLine(m.stream, m.text);
        break;
      case "exit":
        if (engine && m.id === engine.id) {
          engine.failAll(new Error("engine exited"));
          const why = stderrTail.slice(-2).join(" · ");
          state.engine.ready = false;
          state.engine.error = `${PROFILES[state.engine.kind].name} stopped (exit code ${m.code})${why ? ": " + why : ""}`;
          state.thinking = false;
          scheduleRender();
        }
        break;
      case "file":
        loadSgf(m.content);
        break;
      case "saved":
        savePath = m.path;
        toast("Saved " + m.path);
        break;
      case "save-failed":
        toast("Could not save " + m.path);
        break;
    }
  });

  Panels.init({
    boardClick: (p) => tryPlay(p),
    hover: (p) => {
      if (selftestTrace) return;  // keep the real mouse out of self test captures
      const same = p && state.hover && p.x === state.hover.x && p.y === state.hover.y;
      if (same || (!p && !state.hover)) return;
      state.hover = p;
      if (state.nodes.length) Panels.renderBoard(state);
    },
    playMove: (gtp) => { if (state.tab !== "play") tryPlay(Go.fromGtp(gtp, state.size)); },
    goTo,
    goToNode,
  });

  for (const b of document.querySelectorAll("#tabs button")) {
    b.addEventListener("click", () => { state.tab = b.dataset.tab; scheduleRender(); requestSync(); });
  }
  for (const b of document.querySelectorAll("#size-picker button")) {
    b.addEventListener("click", () => { if (!b.disabled) newGame(parseInt(b.dataset.size, 10)); });
  }
  $("new-game").addEventListener("click", () => newGame(state.size));
  $("pass").addEventListener("click", () => tryPlay(null));
  $("engine-move").addEventListener("click", () => { wantEngineMove = true; requestSync(); });
  $("review-game").addEventListener("click", toggleReview);
  $("toggle-left").addEventListener("click", () => togglePane("hideLeft"));
  $("toggle-right").addEventListener("click", () => togglePane("hideRight"));
  $("territory-toggle").addEventListener("click", () => { state.showTerritory = !state.showTerritory; scheduleRender(); });
  $("analysis-toggle").addEventListener("click", togglePause);
  $("scheme-toggle").addEventListener("click", toggleScheme);
  // Open and save share one dropdown, opened from the merged folder/disk icon.
  function closeSgfMenu() {
    $("sgf-menu").hidden = true;
    $("sgf-button").setAttribute("aria-expanded", "false");
  }
  $("sgf-button").addEventListener("click", (e) => {
    e.stopPropagation();
    const open = $("sgf-menu").hidden;
    if (open) showSavePath();
    $("sgf-menu").hidden = !open;
    $("sgf-button").setAttribute("aria-expanded", String(open));
  });
  $("open-sgf").addEventListener("click", () => { closeSgfMenu(); send("open-sgf"); });
  $("save-sgf").addEventListener("click", () => { closeSgfMenu(); saveSgf(false); });
  $("save-sgf-as").addEventListener("click", () => { closeSgfMenu(); saveSgf(true); });
  document.addEventListener("click", (e) => { if (!$("sgf-menu").hidden && !e.target.closest(".menu-anchor")) closeSgfMenu(); });
  $("open-settings").addEventListener("click", openSettings);
  $("settings").addEventListener("close", () => { if ($("settings").returnValue === "ok") applySettings(); });
  $("prev").addEventListener("click", () => goTo(state.index - 1));
  $("next").addEventListener("click", () => goTo(state.index + 1));
  window.addEventListener("resize", scheduleRender);
  document.addEventListener("keydown", (e) => {
    if ($("settings").open) return;
    if (e.key === "Escape" && !$("sgf-menu").hidden) { closeSgfMenu(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === "s") { e.preventDefault(); closeSgfMenu(); saveSgf(e.shiftKey); return; }
    if (e.key === "ArrowLeft") goTo(state.index - 1);
    else if (e.key === "ArrowRight") goTo(state.index + 1);
    else if (e.key === "ArrowUp") { e.preventDefault(); switchBranch(-1); }
    else if (e.key === "ArrowDown") { e.preventDefault(); switchBranch(1); }
    else if (e.key === "Home") goTo(0);
    else if (e.key === "End") goTo(state.nodes.length - 1);
    else if (e.key === " ") { e.preventDefault(); togglePause(); }
  });

  send("hello");
})();
