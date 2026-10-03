// Awantura o kasę — live view for players (read only).
// The host's iPhone app sends a PublicGameState snapshot to Supabase Realtime
// Broadcast channel "awantura:<KOD>" on every change + every 3 s. This page
// only listens. The snapshot never contains the right answer before the host
// judges, nor the black box prize before it is opened.
(() => {
  "use strict";
  const SUPABASE_URL = "https://zqqaxuockfnemgaqline.supabase.co";
  // Publishable (public) key — safe in a web page, no secrets here.
  const SUPABASE_KEY = "sb_publishable_b4TAtta0Fm5Djj7DBIVRaw_bbrxXUDp";
  const ALPHABET = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const debug = new URLSearchParams(location.search).has("debug");

  const params = new URLSearchParams(location.search);
  const code = (params.get("k") || "").toUpperCase().trim();
  window.__awantura = { lags: [], last: null };

  if (!ALPHABET.test(code)) {
    $("nocode").hidden = false;
    $("codeForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const c = $("codeInput").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (ALPHABET.test(c)) location.search = "?k=" + c;
    });
    return;
  }
  $("code").textContent = "KOD " + code;

  // ---- state ----------------------------------------------------------------
  const hostKey = "awantura.host." + code;
  let hostId = sessionStorage.getItem(hostKey);
  let lastSentAt = 0;
  let lastMsgAt = 0;
  let state = null;
  let mine = localStorage.getItem("awantura.mine") || "";

  // ---- realtime -------------------------------------------------------------
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    realtime: { params: { eventsPerSecond: 20 } },
  });
  const viewerKey = Math.random().toString(36).slice(2);
  const channel = sb.channel("awantura:" + code, {
    config: { broadcast: { self: false }, presence: { key: viewerKey } },
  });
  channel
    .on("broadcast", { event: "state" }, ({ payload }) => onSnapshot(payload))
    .on("presence", { event: "sync" }, () => {
      const n = Object.keys(channel.presenceState()).length;
      $("viewers").textContent = n > 0 ? `OGLĄDA: ${n}` : "";
    })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        setStatus(state ? "live" : "wait");
        channel.track({ at: Date.now() });
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        setStatus("off");
      }
    });

  function onSnapshot(p) {
    if (!p || p.code !== code || typeof p.hostId !== "string") return;
    // Only the host that spoke first on this code may drive the page.
    if (!hostId) { hostId = p.hostId; sessionStorage.setItem(hostKey, hostId); }
    if (p.hostId !== hostId) return;
    if (p.sentAt && p.sentAt < lastSentAt) return;  // late / out of order
    lastSentAt = p.sentAt || lastSentAt;
    lastMsgAt = Date.now();
    const lag = p.sentAt ? Date.now() - p.sentAt : null;
    if (lag != null) { window.__awantura.lags.push(lag); if (window.__awantura.lags.length > 200) window.__awantura.lags.shift(); }
    window.__awantura.last = p;
    const same = state && JSON.stringify({ ...state, sentAt: 0, seq: 0 }) === JSON.stringify({ ...p, sentAt: 0, seq: 0 });
    state = p;
    setStatus("live", lag);
    if (!same) render(p);
  }

  function setStatus(kind, lag) {
    const el = $("status");
    el.className = "box status " + kind;
    $("statusText").textContent =
      kind === "live" ? (debug && lag != null ? `NA ŻYWO ${lag} MS` : "NA ŻYWO")
      : kind === "stale" ? "BRAK SYGNAŁU"
      : kind === "wait" ? "CZEKAM NA GRĘ"
      : kind === "off" ? "OFFLINE" : "ŁĄCZĘ…";
  }
  setInterval(() => {
    if (state && Date.now() - lastMsgAt > 8000) setStatus("stale");
  }, 2000);

  // ---- animated LED numbers ---------------------------------------------------
  const tweens = new Map();
  function num(el, value) {
    const from = Number(el.dataset.v ?? value);
    el.dataset.v = value;
    if (from === value) { el.textContent = value; return; }
    const d = Math.min(2200, Math.max(350, Math.abs(value - from) / 2.5));
    const t0 = performance.now();
    cancelAnimationFrame(tweens.get(el));
    const step = (t) => {
      const u = Math.min(1, (t - t0) / d);
      const e = 1 - Math.pow(1 - u, 3);
      el.textContent = Math.round(from + (value - from) * e);
      if (u < 1) tweens.set(el, requestAnimationFrame(step));
    };
    tweens.set(el, requestAnimationFrame(step));
  }
  // Re-rendered markup carries data-num="key"; values persist across renders.
  const lastNums = {};
  function settleNums(root) {
    root.querySelectorAll("[data-num]").forEach((el) => {
      const k = el.dataset.num, v = Number(el.dataset.target);
      if (Number.isNaN(v)) return;
      el.dataset.v = lastNums[k] ?? v;
      el.textContent = el.dataset.v;
      num(el, v);
      lastNums[k] = v;
    });
  }

  // ---- render -------------------------------------------------------------
  const teamById = (s, id) => s.teams.find((t) => t.id === id);
  const tclass = (id) => "t-" + id;

  function render(s) {
    const playing = s.teams.filter((t) => t.playing);
    // round / stage
    const stageName = s.stage === "final" ? "FINAŁ" : "RUNDA";
    $("round").textContent =
      s.phase === "gameEnd" ? "KONIEC GRY" : s.phase === "stageEnd" ? "KONIEC ETAPU 1"
      : s.phase === "setup" ? "PRZYGOTOWANIE"
      : s.bonus ? `${stageName} BONUSOWA` : `${stageName} ${s.questionNumber}/${s.rounds}`;
    // teams
    const teams = $("teams");
    teams.style.setProperty("--n", Math.max(1, playing.length));
    teams.innerHTML = playing.map((t) => `
      <div class="team ${tclass(t.id)} ${t.id === "masters" ? "masters" : ""} ${t.bankrupt ? "bankrupt" : ""} ${t.id === mine ? "mine" : ""}">
        <div class="name">${esc(t.name)}</div>
        <div class="money led" data-num="total-${t.id}" data-target="${t.total}">${t.total}</div>
      </div>`).join("");
    // pot + category
    const potEl = $("pot").querySelector("[data-num]");
    potEl.dataset.target = s.pot;
    $("category").textContent = s.fieldTitle || (s.phase === "wheel" ? "KOŁO" : "AWANTURA O KASĘ");
    // stage panel
    $("stage").innerHTML = panel(s);
    settleNums(document.body);
    chips(s);
  }

  function panel(s) {
    switch (s.phase) {
      case "setup": return waiting("CZEKAMY NA START", "Prowadzący ustawia drużyny.");
      case "wheel": return waiting("KOŁO", "Prowadzący kręci kołem…");
      case "auction": return auction(s);
      case "question": return question(s);
      case "roundResult": return result(s);
      case "stageEnd": case "gameEnd": return end(s);
      default: return "";
    }
  }

  function waiting(title, line) {
    return `<div class="waiting"><div class="led">${esc(title)}</div><div>${esc(line)}</div></div>`;
  }

  function auction(s) {
    const rows = s.teams.filter((t) => t.playing).map((t) => {
      const cls = `bid ${tclass(t.id)} ${t.leading ? "leading" : ""} ${t.vaBanque ? "vb" : ""} ${t.inAuction ? "" : "out"}`;
      const tile = t.inAuction
        ? `<div class="tile led" data-num="bid-${t.id}" data-target="${t.bid}">${t.bid}</div>`
        : `<div class="tile">${t.bankrupt ? "BANKRUT · NIE LICYTUJE" : "NIE GRA"}</div>`;
      const badges = (t.leading ? `<span class="badge">PROWADZI</span>` : "") + (t.vaBanque ? `<span class="badge vb">VA BANQUE</span>` : "");
      return `<div class="${cls}">
        <div class="row"><span>${esc(t.name)}${t.hintTokens ? " · PODPOWIEDŹ ×" + t.hintTokens : ""}</span><span class="kasa">KASA ${t.balance}</span></div>
        <div style="position:relative">${tile}${badges}</div>
      </div>`;
    }).join("");
    return `<div class="panel-title center">${s.bankAuction ? "LICYTACJA BEZ PULI" : "L I C Y T A C J A"}</div>${rows}`;
  }

  function question(s) {
    const q = s.question;
    const team = q.team ? teamById(s, q.team) : null;
    const tc = team ? tclass(team.id) : "";
    const t = q.timeLeft;
    const timerCls = t === 0 ? "zero" : t <= 10 ? "low" : "";
    const who = q.duel ? "1 NA 1 · KTO PIERWSZY" : team ? esc(team.name) : "";
    const answers = q.answers
      ? `<div class="answers">${q.answers.map((a, i) => `<div class="answer"><span class="chip led">${"ABCD"[i]}</span>${esc(a)}</div>`).join("")}</div>`
      : "";
    return `<div class="qtop ${tc}">
        <div class="who"><span class="label">${esc(q.category)}</span><b>${who}</b><span class="label">${q.timerRunning ? "CZAS" : t === 0 ? "KONIEC CZASU" : "PAUZA"}</span></div>
        <div class="timer led ${timerCls}">${t}</div>
      </div>
      <div class="q ${tc} ${q.duel ? "duel" : ""}" style="${q.duel ? "--tc:#000" : ""}">
        <div class="text">${esc(q.text)}</div>${answers}
      </div>`;
  }

  function result(s) {
    const r = s.result;
    const team = r.team ? teamById(s, r.team) : null;
    const name = team ? esc(team.name) : "";
    const tc = team ? tclass(team.id) : "";
    let title = "", note = "", big = `<div class="led" data-num="res" data-target="${r.amount}">${r.amount}</div>`;
    if (r.kind === "correct") { title = `DOBRZE · ${name} ZGARNIA PULĘ`; note = "WYGRANA"; }
    else if (r.kind === "wrong") { title = team ? `ŹLE · ${name}` : "NIKT NIE ODPOWIEDZIAŁ"; note = r.amount > 0 ? `PULA ${r.amount} PRZECHODZI DALEJ` : "PULA BYŁA PUSTA"; big = `<div class="led" data-num="res0" data-target="0">0</div>`; }
    else if (r.kind === "hint") { title = `PODPOWIEDŹ DLA: ${name}`; note = `ZAPŁACILI ${r.amount} ZŁ`; big = `<div class="led" style="font-size:30px">PODPOWIEDŹ</div>`; }
    else if (r.kind === "box") { title = `CZARNA SKRZYNKA DLA: ${name}`; note = `ZAPŁACILI ${r.amount} ZŁ · CO W ŚRODKU? NA KOŃCU GRY`; big = `<div class="boxicon led">?</div>`; }
    const answer = r.correctAnswer ? `<div class="answer-line"><span class="label">POPRAWNA ODPOWIEDŹ</span><b>${esc(r.correctAnswer)}</b></div>` : "";
    return `<div class="result ${tc}"><div class="panel-title center">${title}</div>
      <div class="big">${big}<div class="note">${note}</div></div>${answer}</div>`;
  }

  function end(s) {
    const w = s.winner ? teamById(s, s.winner) : null;
    const title = s.phase === "stageEnd" ? "KONIEC ETAPU 1 · DO FINAŁU IDZIE"
      : s.stage === "final" ? (s.winner === "masters" ? "MISTRZOWIE OBRONILI TYTUŁ" : "NOWI MISTRZOWIE") : "ZWYCIĘZCA";
    const winner = w ? `<div class="winner ${tclass(w.id)}"><div class="panel-title center">${title}</div>
      <div class="big"><div class="led t">${esc(w.name)}</div><div class="led n" data-num="win" data-target="${w.total}">${w.total}</div><div class="note">ZŁ</div></div></div>` : "";
    const ranking = [...s.teams].sort((a, b) => b.total - a.total).map((t) =>
      `<div class="r ${tclass(t.id)}"><span><span class="sw"></span>${esc(t.name)}</span><span class="led">${t.total}</span></div>`).join("");
    const boxes = s.boxes.length ? `<div class="boxes"><div class="panel-title center">CZARNE SKRZYNKI</div>${s.boxes.map((b) => {
      const owner = teamById(s, b.owner);
      return `<div class="boxrow"><div class="boxicon led">${b.open ? "!" : "?"}</div><div><div class="label">${esc(owner ? owner.name : "")}</div>
        <div class="prize led">${b.open ? esc(b.prize) : "ZAMKNIĘTA"}</div></div></div>`;
    }).join("")}</div>` : "";
    return `${winner}${boxes}<div class="rank"><div class="panel-title center">WYNIKI</div>${ranking}</div>`;
  }

  // ---- "my team" ------------------------------------------------------------
  function chips(s) {
    const teams = s.teams.filter((t) => t.id !== "masters" || t.playing);
    $("chips").innerHTML = teams.map((t) =>
      `<button class="chip-btn ${tclass(t.id)} ${t.id === mine ? "on" : ""}" data-id="${t.id}">${esc(t.name)}</button>`).join("");
  }
  $("chips").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-id]");
    if (!b) return;
    mine = mine === b.dataset.id ? "" : b.dataset.id;
    localStorage.setItem("awantura.mine", mine);
    if (state) render(state);
    keepAwake();
  });

  // ---- keep the screen on -------------------------------------------------
  let lock = null;
  async function keepAwake() {
    try {
      if ("wakeLock" in navigator && (!lock || lock.released)) lock = await navigator.wakeLock.request("screen");
    } catch (_) { /* needs a tap on some browsers — retried on the next tap */ }
  }
  keepAwake();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") keepAwake(); });
  document.addEventListener("click", keepAwake, { passive: true });

  render({ phase: "setup", stage: "main", teams: [], pot: 0, questionNumber: 0, rounds: 0, boxes: [] });
  setStatus("connecting");
})();
