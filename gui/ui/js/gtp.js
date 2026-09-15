// GTP engine client and analysis parsers for KataGo and Leela Zero.
// Browser global (window.Gtp) or CommonJS module for tests.
(function (root) {
  "use strict";

  // ---- analysis parsing ----
  // Both engines report from the side to move's point of view (KataGo is
  // started with reportAnalysisWinratesAs=SIDETOMOVE).
  // Output: { candidates: [{move, visits, winrate 0..1, scoreLead|null, prior 0..1, lcb, order, pv}],
  //           ownership: Float32Array|null }
  // ownership is row-major from the top-left point; +1 = owned by the side to move.
  function parseInfoLine(line, kind) {
    let body = line, ownership = null;
    const ownAt = line.indexOf(" ownership ");
    if (ownAt >= 0) {
      body = line.slice(0, ownAt);
      const tail = line.slice(ownAt + 11).split(" ownershipStdev ")[0];
      ownership = Float32Array.from(tail.trim().split(/\s+/).map(Number));
    }
    const candidates = [];
    for (const seg of body.split(/(?:^|\s)info\s+/).filter((s) => s.trim())) {
      const pvAt = seg.indexOf(" pv ");
      const head = (pvAt >= 0 ? seg.slice(0, pvAt) : seg).trim().split(/\s+/);
      const pv = pvAt >= 0 ? seg.slice(pvAt + 4).trim().split(/\s+/) : [];
      const d = {};
      for (let i = 0; i + 1 < head.length; i += 2) d[head[i]] = head[i + 1];
      if (!d.move) continue;
      const scale = kind === "leelaz" ? 10000 : 1;  // lz-analyze uses 0..10000
      candidates.push({
        move: d.move,
        visits: parseInt(d.visits, 10) || 0,
        winrate: parseFloat(d.winrate) / scale,
        scoreLead: d.scoreLead !== undefined ? parseFloat(d.scoreLead) : null,
        prior: parseFloat(d.prior) / scale,
        lcb: d.lcb !== undefined ? parseFloat(d.lcb) / scale : null,
        order: d.order !== undefined ? parseInt(d.order, 10) : candidates.length,
        pv,
      });
    }
    candidates.sort((a, b) => a.order - b.order);
    return { candidates, ownership };
  }

  // kata-raw-nn output -> { policy: Float32Array (NaN = occupied), pass, whiteWin }
  function parseRawNn(lines, size) {
    const t = lines.map((l) => l.trim());
    const at = t.indexOf("policy");
    if (at < 0) throw new Error("kata-raw-nn output has no policy section");
    const policy = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      const row = t[at + 1 + y].split(/\s+/);
      for (let x = 0; x < size; x++) policy[y * size + x] = row[x].toUpperCase() === "NAN" ? NaN : parseFloat(row[x]);
    }
    const value = (key) => {
      const l = t.find((s) => s.startsWith(key + " "));
      return l ? parseFloat(l.split(/\s+/)[1]) : null;
    };
    return { policy, pass: value("policyPass"), whiteWin: value("whiteWin") };
  }

  // ---- engine client ----
  // bridge: { send(fields...) } posts to the host; call engine.onLine(stream, text) for host lines.
  class Engine {
    constructor(id, kind, bridge) {
      this.id = id;
      this.kind = kind;            // "katago" | "leelaz"
      this.bridge = bridge;
      this.queue = [];
      this.current = null;         // {cmd, resolve, reject, lines, header, stream, onInfo}
      this.onStderr = null;
    }

    start(cwd, cmdline) { this.bridge.send("start", this.id, cwd, cmdline); }
    stop() { this.bridge.send("stop", this.id); this.failAll(new Error("engine stopped")); }

    // Regular command: resolves with the response text after "= ".
    command(cmd) {
      return new Promise((resolve, reject) => this.enqueue({ cmd, resolve, reject, lines: [], header: null }));
    }

    // Streaming analysis (kata-analyze / lz-analyze). Resolves when a later
    // command interrupts it; onInfo receives each parsed info line.
    analyze(cmd, onInfo) {
      return new Promise((resolve, reject) =>
        this.enqueue({ cmd, resolve, reject, lines: [], header: null, stream: true, onInfo }));
    }

    enqueue(job) {
      this.queue.push(job);
      if (this.current && this.current.stream && !this.current.interrupted) {
        // Any command ends the analysis; its reply follows the analysis' blank line.
        this.current.interrupted = true;
        this.write(this.queue.shift());
      } else if (!this.current) {
        this.write(this.queue.shift());
      }
    }

    write(job) {
      if (!this.current) this.current = job;
      else this.pendingAfterStream = job;
      this.bridge.send("send", this.id, job.cmd);
    }

    onLine(stream, text) {
      if (stream === "err") { if (this.onStderr) this.onStderr(text); return; }
      const job = this.current;
      if (!job) return;
      if (job.header === null) {
        if (text.startsWith("=") || text.startsWith("?")) {
          job.header = text[0];
          const rest = text.slice(1).trim();
          if (rest) job.lines.push(rest);
        }
        return;
      }
      if (text === "") { this.finish(); return; }
      if (job.stream && text.startsWith("info ")) {
        if (job.onInfo) job.onInfo(parseInfoLine(text, this.kind));
      } else {
        job.lines.push(text);
      }
    }

    finish() {
      const job = this.current;
      this.current = null;
      if (job.header === "?") job.reject(new Error(`${job.cmd}: ${job.lines.join(" ")}`));
      else job.resolve(job.lines.join("\n"));
      if (this.pendingAfterStream) {
        this.current = this.pendingAfterStream;
        this.pendingAfterStream = null;
      } else if (this.queue.length) {
        this.write(this.queue.shift());
      }
    }

    failAll(err) {
      const jobs = [this.current, this.pendingAfterStream, ...this.queue].filter(Boolean);
      this.current = this.pendingAfterStream = null;
      this.queue = [];
      for (const j of jobs) j.reject(err);
    }
  }

  const Gtp = { Engine, parseInfoLine, parseRawNn };
  if (typeof module !== "undefined" && module.exports) module.exports = Gtp;
  else root.Gtp = Gtp;
})(this);
