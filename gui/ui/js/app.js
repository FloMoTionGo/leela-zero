// Front window logic: game state, engine control, settings, SGF and self test.
// Depends on Go, Gtp, Board and Panels. Talks to the host through
// window.chrome.webview (see gui/host/main.cpp for the message format).
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const DEFAULTS = { engine: "katago", komi: 7.5, human: 1, visits: 400, threads: 8, dark: false };
  const PROFILES = {
    katago: {
      name: "KataGo", sizes: [9, 13, 19], dir: "katago", protocol: "katago",
      network: "kata1-b18c384nbt", backend: "CPU · Eigen AVX2",
      // Analysis ignores maxVisits; it only limits genmove.
      cmd: (dir, s) => `"${dir}\\katago.exe" gtp -model b18c384nbt.bin.gz -config gtp_cpu.cfg -override-config ` +
        `numSearchThreads=${s.threads},reportAnalysisWinratesAs=SIDETOMOVE,ponderingEnabled=false,maxVisits=${s.visits}`,
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
    size: 19, komi: DEFAULTS.komi, tab: "analyze", setup: [],
    engine: { kind: "katago", ready: false, version: "", network: "", backend: "", error: "" },
    nodes: [], index: 0, paused: false, thinking: false, speed: null,
    showTerritory: false, policy: null, hover: null, resignedAt: -1,
    review: null,  // {visits} while "Analyze game" steps through the moves
  };
  let settings = { ...DEFAULTS };
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

  // ---------------- game tree (main line only) ----------------
  function newGame(size, setup = [], moves = []) {
    state.size = size;
    state.setup = setup;
    state.policy = null;
    state.resignedAt = -1;
    const position = new Go.Position(size);
    for (const s of setup) position.grid[s.vertex.y * size + s.vertex.x] = s.color;
    const handicap = setup.length > 0 && setup.every((s) => s.color === Go.BLACK);
    state.nodes = [{ position, move: null, toPlay: handicap ? Go.WHITE : Go.BLACK, analysis: null }];
    for (const m of moves) {
      const last = state.nodes[state.nodes.length - 1];
      const next = last.position.play(m.color, m.vertex);
      if (!next) { toast(`Move ${state.nodes.length} in the file is illegal; the game stops there.`); break; }
      state.nodes.push({ position: next, move: m, toPlay: Go.other(m.color), analysis: null });
    }
    state.index = state.nodes.length - 1;
    positionChanged();
  }

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
    const next = node.position.play(node.toPlay, vertex);
    if (!next) { toast("Illegal move"); return; }
    state.nodes.length = state.index + 1;
    state.nodes.push({ position: next, move: { color: node.toPlay, vertex }, toPlay: Go.other(node.toPlay), analysis: null });
    state.index++;
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

  function gameOver() {
    const n = state.nodes, i = state.index;
    const passes = i >= 2 && n[i].move.vertex === null && n[i - 1].move.vertex === null;
    return passes || state.resignedAt === i;
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

    const idx = state.index;
    if (state.engine.kind === "katago" && !(state.policy && state.policy.index === idx)) {
      try {
        const raw = await engine.command("kata-raw-nn 0");
        if (!syncAgain && state.index === idx) {
          state.policy = { index: idx, ...Gtp.parseRawNn(raw.split("\n"), state.size) };
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
    if (!state.paused) startAnalysis(idx);
  }

  async function engineMove() {
    const idx = state.index, node = current(), color = node.toPlay;
    const prof = PROFILES[state.engine.kind];
    state.thinking = true;
    scheduleRender();
    try {
      await engine.command(prof.beforeGenmove(settings));
      const reply = (await engine.command(`genmove ${color === Go.BLACK ? "b" : "w"}`)).trim();
      if (prof.afterGenmove) await engine.command(prof.afterGenmove);
      if (/^resign$/i.test(reply)) {
        state.resignedAt = idx;
        toast(`${prof.name} resigns`);
        return;
      }
      const vertex = Go.fromGtp(reply, state.size);
      const next = node.position.play(color, vertex);
      if (!next || state.index !== idx) { engineMoves = null; return; }
      state.nodes.length = idx + 1;
      state.nodes.push({ position: next, move: { color, vertex }, toPlay: Go.other(color), analysis: null });
      state.index = idx + 1;
      engineMoves.moves.push({ color, vertex });
      state.policy = null;
    } finally {
      state.thinking = false;
      scheduleRender();
      syncAgain = true;  // the running sync loop continues with the new position
    }
  }

  function startAnalysis(idx) {
    let last = null;
    engine.analyze(PROFILES[state.engine.kind].analyze, (info) => {
      const node = state.nodes[idx];
      if (!node || state.index !== idx || !info.candidates.length) return;
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
    newGame(game.size, setup, game.moves);
  }

  function saveSgf() {
    const game = {
      size: state.size, komi: state.komi, black: "", white: "", setup: state.setup,
      moves: state.nodes.slice(1).map((n) => n.move),
    };
    send("save-sgf", `game-${new Date().toISOString().slice(0, 10)}.sgf`, Go.writeSgf(game));
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
    newGame(size, [], opening.map((v, i) => ({ color: i % 2 ? Go.WHITE : Go.BLACK, vertex: Go.fromGtp(v, size) })));
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
        applyScheme(settings.dark);
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
        toast("Saved " + m.path);
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
  $("territory-toggle").addEventListener("click", () => { state.showTerritory = !state.showTerritory; scheduleRender(); });
  $("analysis-toggle").addEventListener("click", togglePause);
  $("scheme-toggle").addEventListener("click", toggleScheme);
  $("open-sgf").addEventListener("click", () => send("open-sgf"));
  $("save-sgf").addEventListener("click", saveSgf);
  $("open-settings").addEventListener("click", openSettings);
  $("settings").addEventListener("close", () => { if ($("settings").returnValue === "ok") applySettings(); });
  $("prev").addEventListener("click", () => goTo(state.index - 1));
  $("next").addEventListener("click", () => goTo(state.index + 1));
  window.addEventListener("resize", scheduleRender);
  document.addEventListener("keydown", (e) => {
    if ($("settings").open) return;
    if (e.key === "ArrowLeft") goTo(state.index - 1);
    else if (e.key === "ArrowRight") goTo(state.index + 1);
    else if (e.key === "Home") goTo(0);
    else if (e.key === "End") goTo(state.nodes.length - 1);
    else if (e.key === " ") { e.preventDefault(); togglePause(); }
  });

  send("hello");
})();
