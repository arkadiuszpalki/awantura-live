// Awantura o kasę — live view for players (read only), "my team" edition.
//
// The host's iPhone app sends a PublicGameState snapshot on every change:
// WI-FI mode (default) over a WebSocket straight from the phone (?w=<port>),
// INTERNET mode via Supabase Realtime Broadcast channel "awantura:<KOD>"
// (+ every 3 s for latecomers). This page only listens. The snapshot never
// contains the right answer before the host judges, nor a black box prize
// before it is opened.
//
// Each player first picks their team. Then the screen follows the game:
//   no question (wheel, results, breaks) → whole screen in MY colour edge to
//            edge, my money huge, top bar + bottom bar with what just happened
//   Team switch = tap another team's tile (top bar) or column (auction).
//   auction  → team columns: KONTO / OFERTA, PULA underneath
//   question → PULA ——— CZAS bar, the question full screen in the answering colour
(() => {
  "use strict";
  const SUPABASE_URL = "https://zqqaxuockfnemgaqline.supabase.co";
  // Publishable (public) key — safe in a web page, no secrets here.
  const SUPABASE_KEY = "sb_publishable_b4TAtta0Fm5Djj7DBIVRaw_bbrxXUDp";
  const ALPHABET = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const params = new URLSearchParams(location.search);
  const debug = params.has("debug");
  const code = (params.get("k") || "").toUpperCase().trim();
  window.__awantura = { lags: [], last: null };

  if (!ALPHABET.test(code)) {
    $("nocode").hidden = false;
    $("codeForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const c = $("codeInput").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (ALPHABET.test(c)) location.search = "?k=" + c + (params.get("w") ? "&w=" + encodeURIComponent(params.get("w")) : "");
    });
    return;
  }

  // ---- state ----------------------------------------------------------------
  const hostKey = "awantura.host." + code;
  let hostId = sessionStorage.getItem(hostKey);
  let lastSentAt = 0, lastMsgAt = 0;
  let state = null;
  let mine = localStorage.getItem("awantura.mine") || "";
  // ?t=blue|green|yellow|masters preselects the team (e.g. a link per team).
  if (/^(blue|green|yellow|masters)$/.test(params.get("t") || "")) { mine = params.get("t"); localStorage.setItem("awantura.mine", mine); }
  let picking = false;          // team picker open (corner button)
  let statusKind = "connecting", statusText = "ŁĄCZĘ…", viewers = 0;
  let clock = null;             // { left, running, at } — counted down here, re-synced by every snapshot

  // ---- transport ------------------------------------------------------------
  // WI-FI (default): the host's phone serves this page itself and pushes every
  // snapshot over a WebSocket on port `w` — no internet, no CDN.
  // INTERNET: Supabase Realtime Broadcast (supabase-js loaded only here).
  const wsPort = /^\d{2,5}$/.test(params.get("w") || "") ? params.get("w") : null;
  window.__awantura.mode = wsPort ? "wifi" : "internet";
  const showViewers = (n) => { viewers = n; if (!state || picking || !mine) render(); };

  if (wsPort) connectLocal(); else connectInternet();

  function connectLocal() {
    let backoff = 400, sock = null, timer = 0;
    const open = () => {
      clearTimeout(timer);
      if (sock && sock.readyState <= 1) return;
      sock = new WebSocket(`ws://${location.hostname}:${wsPort}/`);
      sock.onopen = () => {
        backoff = 400; lastMsgAt = Date.now(); setStatus(state ? "live" : "wait");
        // Say which game this screen watches: only screens on the current code count as viewers (v13).
        try { sock.send(JSON.stringify({ hello: code })); } catch (_) {}
      };
      sock.onmessage = (e) => {
        let p; try { p = JSON.parse(e.data); } catch (_) { return; }
        // The host is on another game code: go over to it by ourselves (v13).
        if (p && typeof p.newgame === "string" && ALPHABET.test(p.newgame) && p.newgame !== code) {
          const q = new URLSearchParams(location.search); q.set("k", p.newgame);
          location.replace(location.pathname + "?" + q.toString() + location.hash);
          return;
        }
        if (p && p.hb) {  // heartbeat from the host phone every 3 s
          lastMsgAt = Date.now();
          if (typeof p.viewers === "number" && p.viewers !== viewers) showViewers(p.viewers);
          if (state && statusKind === "stale") setStatus("live");
          return;
        }
        onSnapshot(p);
      };
      sock.onclose = () => {
        setStatus("off");
        timer = setTimeout(open, backoff);   // host app in background / Wi-Fi blip: keep trying
        backoff = Math.min(backoff * 2, 3000);
      };
      sock.onerror = () => { try { sock.close(); } catch (_) {} };
    };
    open();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") { backoff = 400; open(); }
    });
  }

  function connectInternet() {
    const tag = document.createElement("script");
    tag.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.min.js";
    tag.onload = startSupabase;
    tag.onerror = () => setStatus("off");
    document.head.appendChild(tag);
  }

  function startSupabase() {
    const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      realtime: { params: { eventsPerSecond: 20 } },
    });
    const viewerKey = Math.random().toString(36).slice(2);
    const channel = sb.channel("awantura:" + code, {
      config: { broadcast: { self: false }, presence: { key: viewerKey } },
    });
    channel
      .on("broadcast", { event: "state" }, ({ payload }) => onSnapshot(payload))
      .on("presence", { event: "sync" }, () => showViewers(Object.keys(channel.presenceState()).length))
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setStatus(state ? "live" : "wait");
          channel.track({ at: Date.now() });
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          setStatus("off");
        }
      });
  }

  let leftUntil = 0, leftText = "";
  function onSnapshot(p) {
    if (!p || p.code !== code || typeof p.hostId !== "string") return;
    // Only the host that spoke first on this code may drive the page.
    if (!hostId) { hostId = p.hostId; sessionStorage.setItem(hostKey, hostId); }
    if (p.hostId !== hostId) return;
    if (p.sentAt && p.sentAt < lastSentAt) return;  // late / out of order
    const fresh = p.sentAt !== lastSentAt;
    lastSentAt = p.sentAt || lastSentAt;
    lastMsgAt = Date.now();
    const lag = p.sentAt ? Math.round(Date.now() - p.sentAt) : null;
    if (lag != null && fresh) { window.__awantura.lags.push(lag); if (window.__awantura.lags.length > 200) window.__awantura.lags.shift(); }
    window.__awantura.last = p;
    // Host clock → this phone's clock (network lag included): for the wheel.
    if (p.sentAt) skew = Date.now() - p.sentAt;
    // Clock: counted down on this phone, re-synced by every snapshot.
    const q = p.question;
    if (q) {
      if (!clock || clock.left !== q.timeLeft || clock.running !== (q.timerRunning && !q.hintOffer)) {
        clock = { left: q.timeLeft, running: q.timerRunning && !q.hintOffer, at: Date.now() };
      }
    } else clock = null;
    // The last category left after crossing out: "ZOSTAŁA: …" for 1.5 s (v13).
    if (state && state.phase === "strike" && p.phase === "question" && p.question) {
      leftUntil = Date.now() + 1500; leftText = "ZOSTAŁA: " + p.question.category;
      setTimeout(() => render(), 1550);
    }
    const same = state && JSON.stringify({ ...state, sentAt: 0, seq: 0 }) === JSON.stringify({ ...p, sentAt: 0, seq: 0 });
    state = p;
    setStatus("live", lag);
    if (!same) render();
  }

  function setStatus(kind, lag) {
    statusKind = kind;
    statusText =
      kind === "live" ? (debug && lag != null ? `NA ŻYWO ${lag} MS` : "NA ŻYWO")
      : kind === "stale" ? "BRAK SYGNAŁU OD PROWADZĄCEGO"
      : kind === "wait" ? "CZEKAM NA GRĘ"
      : kind === "off" ? "BRAK POŁĄCZENIA · ŁĄCZĘ…" : "ŁĄCZĘ…";
    const warn = $("conn");
    warn.hidden = !(kind === "stale" || kind === "off") || !state;
    warn.textContent = statusText;
    if (!state || picking || !mine) { const el = $("pickInfo"); if (el) el.textContent = infoLine(); }
    if (debug) { const d = $("dbg"); d.hidden = false; d.textContent = statusText; }
  }
  setInterval(() => {
    if (state && statusKind !== "off" && Date.now() - lastMsgAt > 8000) setStatus("stale");
  }, 2000);
  const infoLine = () => [statusText, "KOD " + code, viewers > 0 ? `OGLĄDA: ${viewers}` : ""].filter(Boolean).join(" · ");

  // ---- animated LED numbers ---------------------------------------------------
  // Like the host's web prototype: money moves in steps of 100 (100 ms per step
  // up to 2000, 50 ms up to 5000, faster above), and every digit sits in its own
  // fixed cell (the LED font's digits are all the same width) — the changed
  // digits roll vertically like iOS numeric text; the layout never moves.
  const tweens = new Map();
  const fmt = (v, el) => (el.dataset.sign && v > 0 ? "+" : "") + v;
  const stepMs = (d) => (d <= 2000 ? 100 : d <= 5000 ? 50 : 10);
  function paint(el, text, roll) {
    const cells = el.children;
    if (!roll || cells.length !== text.length || !el.dataset.cells) {
      el.dataset.cells = "1";
      el.innerHTML = [...text].map((c) => `<span class="dg"><i>${c}</i></span>`).join("");
      return;
    }
    [...text].forEach((c, i) => {
      const cell = cells[i], cur = cell.lastElementChild.textContent;
      if (cur === c) return;
      // old digit slides up, new one comes from below (iOS numericText feel)
      cell.innerHTML = `<i>${cur}</i><i>${c}</i>`;
      cell.classList.remove("roll"); void cell.offsetWidth; cell.classList.add("roll");
      // after the roll keep only the new digit (nothing parked above it)
      cell.onanimationend = () => { cell.classList.remove("roll"); cell.innerHTML = `<i>${c}</i>`; };
    });
  }
  function num(el, value) {
    const from = Number(el.dataset.v ?? value);
    el.dataset.v = value;
    clearTimeout(tweens.get(el));
    if (from === value) { paint(el, fmt(value, el), false); return; }
    const dir = Math.sign(value - from), d = Math.abs(value - from);
    const ms = el.dataset.dur ? Math.max(10, Number(el.dataset.dur) / Math.max(1, Math.ceil(d / 100))) : stepMs(d);
    let cur = from;
    paint(el, fmt(cur, el), false);
    const tick = () => {
      cur = dir > 0 ? Math.min(value, cur + 100) : Math.max(value, cur - 100);
      // not a multiple of 100 (rare): land exactly on the value
      if (Math.abs(value - cur) < 100) cur = value;
      paint(el, fmt(cur, el), ms >= 40);
      if (cur !== value) tweens.set(el, setTimeout(tick, ms));
    };
    tweens.set(el, setTimeout(tick, Number(el.dataset.delay || 0) + ms));
  }
  // Re-rendered markup carries data-num="key"; values persist across renders.
  const lastNums = {};
  function settleNums(root) {
    root.querySelectorAll("[data-num]").forEach((el) => {
      const k = el.dataset.num, v = Number(el.dataset.target);
      if (Number.isNaN(v)) return;
      const from = el.dataset.from != null && lastNums[k] !== v ? Number(el.dataset.from) : null;
      el.dataset.v = from ?? lastNums[k] ?? v;
      num(el, v);
      lastNums[k] = v;
    });
  }

  // ---- fit text to its box (like SwiftUI minimumScaleFactor) ------------------
  // <span data-fit="max px" data-min="min px">: largest size that fits the parent.
  // Last first: the news lines settle their height before the big amount fills what is left.
  // Bar cells: label next to value; only when that does not fit, the label goes
  // above the value (same sizes) — then `fit` shrinks the value if still needed.
  function fitBars(root) {
    root.querySelectorAll(".bar").forEach((bar) => {
      const cells = [...bar.querySelectorAll(":scope > .cell")];
      bar.classList.remove("stack");
      cells.forEach((c) => c.querySelectorAll("[data-fit]").forEach((v) => { v.style.fontSize = ""; }));
      // Inline: fixed cells keep their natural width, only `grow` cells give
      // way. Too wide → the whole bar puts labels over values; then `fit` shrinks.
      const over = () => bar.scrollWidth > bar.clientWidth + 1 || cells.some((c) => {
        const k = c.querySelector(".k"), v = c.querySelector(".v");
        if (!v) return false;
        const cs = getComputedStyle(c);
        const room = c.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const need = (k && k.textContent ? k.scrollWidth + parseFloat(cs.columnGap || 0) : 0) + v.scrollWidth;
        return need > room + 1;
      });
      if (over()) bar.classList.add("stack");
    });
  }

  function fitAll(root) {
    fitBars(root);
    [...root.querySelectorAll("[data-fit]")].reverse().forEach((el) => {
      const box = el.parentElement, cs = getComputedStyle(box);
      const W = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      let H = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      // data-hbox: the parent grows with the text; take the height left in that ancestor instead.
      const hb = el.dataset.hbox && el.closest("." + el.dataset.hbox);
      if (hb) H = hb.clientHeight - [...hb.children].filter((c) => c !== box).reduce((a, c) => a + c.offsetHeight, 0) - 8;
      if (W <= 0 || H <= 0) return;
      const shown = el.textContent;
      if (el.dataset.probe && el.dataset.probe.length > shown.length) el.textContent = el.dataset.probe;
      if (el.dataset.fit === "css") el.style.fontSize = "";
      let lo = Number(el.dataset.min || 10), hi = el.dataset.fit === "css" ? parseFloat(getComputedStyle(el).fontSize) : Number(el.dataset.fit);
      const fits = (s) => { el.style.fontSize = s + "px"; return el.offsetWidth <= W + 0.5 && el.scrollWidth <= el.offsetWidth + 1 && el.offsetHeight <= H + 0.5; };
      if (!fits(lo)) { el.style.fontSize = lo + "px"; el.textContent = shown; return; }
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (fits(mid)) lo = mid; else hi = mid; }
      el.style.fontSize = lo + "px";
      el.textContent = shown;
    });
    // data-fit-group: siblings (e.g. the auction offers) share the smallest size.
    const groups = {};
    root.querySelectorAll("[data-fit-group]").forEach((el) => (groups[el.dataset.fitGroup] ||= []).push(el));
    Object.values(groups).forEach((els) => {
      const min = Math.min(...els.map((el) => parseFloat(el.style.fontSize) || Infinity));
      if (isFinite(min)) els.forEach((el) => { el.style.fontSize = min + "px"; });
    });
  }
  // Re-fit after rotation (twice: iOS settles the toolbar a moment later) and once the LED font is in.
  let fitQueued = 0, fitLate = 0;
  addEventListener("resize", () => {
    cancelAnimationFrame(fitQueued); clearTimeout(fitLate);
    fitQueued = requestAnimationFrame(() => fitAll(document));
    fitLate = setTimeout(() => fitAll(document), 300);
  });
  if (document.fonts) document.fonts.ready.then(() => fitAll(document));

  // ---- helpers ----------------------------------------------------------------
  const MASTERS = { id: "masters", name: "MISTRZOWIE", balance: 0, bid: 0, total: 0, playing: false, bankrupt: false };
  // Before GRAJ the host has no game yet (no teams in the snapshot): offer the
  // default three with the starting 5000 zł so players can pick while waiting.
  const START = [["blue", "NIEBIESCY"], ["green", "ZIELONI"], ["yellow", "ŻÓŁCI"]]
    .map(([id, name]) => ({ ...MASTERS, id, name, balance: 5000, total: 5000, playing: true }));
  const teamsOf = (s) => s.teams.some((t) => t.id !== "masters") ? s.teams : START;
  const teamById = (s, id) => teamsOf(s).find((t) => t.id === id);
  const tc = (id) => "t-" + (id || "masters");     // colour class; no team (1 NA 1) = black like Mistrzowie
  const nameOf = (s, id) => { const t = id && teamById(s, id); return t ? t.name : id === "masters" ? "MISTRZOWIE" : ""; };
  const led = (key, value, extra = "") => `<span class="led" data-num="${key}" data-target="${value}" ${extra}>${value}</span>`;
  const roundCell = (s) =>
    s.phase === "gameEnd" ? { v: "KONIEC GRY" } : s.phase === "stageEnd" ? { v: "KONIEC ETAPU 1" }
    : s.phase === "setup" ? { v: "PRZED STARTEM" }
    : { k: s.stage === "final" ? "FINAŁ" : "RUNDA", v: s.bonus ? (s.stage === "final" ? "BONUS" : "BONUSOWA") : `${s.questionNumber}/${s.rounds}` };
  // In the final the teams that are out watch it all like on TV (v13).
  const spectator = (s) => s.stage === "final" && s.phase !== "gameEnd" && mine && mine !== "masters" && (() => {
    const t = teamById(s, mine); return t && !t.playing;
  })();

  // ONE bar cell, used by every bar (top, bottom, question, PULA): a small
  // system-font label next to an LED value, same sizes everywhere.
  //   k     label (optional)          v     value (text or number)
  //   n     animated number key       sign  "+" for gains
  //   cls   highlight = background only: good | bad | box | hl | team t-<id> (| out)
  //   id    tap switches to this team grow  takes a bigger share of the width
  //   at    alignment: start | end (default centre)
  // Text values shrink to fit (`fit`), never change font.
  function cell(c) {
    const v = c.n
      ? `<span class="v led" data-num="${c.n}" data-target="${c.v}" ${c.sign ? 'data-sign="1"' : ""} ${c.vid ? `id="${c.vid}"` : ""}>${c.v}</span>`
      : c.v === "" || c.v == null ? ""
      : `<span class="vb"><span class="v led" data-fit="css" data-min="9" ${c.vid ? `id="${c.vid}"` : ""}>${c.v}</span></span>`;
    const k = c.k != null ? `<span class="k" ${c.kid ? `id="${c.kid}"` : ""}>${c.k}</span>` : "";
    const tag = c.id ? "button" : "div";
    return `<${tag} class="cell ${c.cls || ""} ${c.grow ? "grow" : ""} ${c.at ? "at-" + c.at : ""}" ${c.id ? `data-id="${c.id}" aria-label="Zmień drużynę"` : ""} ${c.attrs || ""}>${k}${v}</${tag}>`;
  }
  const barOf = (cells, cls = "") => `<div class="bar ${cls}">${cells.map(cell).join("")}</div>`;

  // A team tile on the top bar: just the money on the team's colour (the colour
  // says whose it is). Bankrupt = dimmed colour + BANKRUT. Tap = become that team.
  const teamCell = (t) => t.bankrupt
    ? { v: "BANKRUT", cls: `team out ${tc(t.id)}`, id: t.id }
    : t.forPot   // after VA BANQUE: 0 on the account, but they play for the whole pot (v13)
    ? { v: "GRA O PULĘ", cls: `team ${tc(t.id)}`, id: t.id }
    : { v: t.total, n: "o-" + t.id, cls: `team ${tc(t.id)}`, id: t.id };

  // Top bar: round · category · (other teams).
  function bar(s, teams = []) {
    return barOf([roundCell(s), { v: s.fieldTitle ? esc(s.fieldTitle) : "", grow: true }, ...teams.map(teamCell)], "top");
  }

  // ---- render -------------------------------------------------------------
  function render() {
    const view = $("view");
    const s = state;
    if (!s) { view.className = "screen plain pad"; view.innerHTML = connecting(); return; }
    if (!picking && mine && s.spin) {
      // The wheel turning (or just stopped) on the host's phone: full screen here
      // too. Same spin = keep the running animation, only refresh the bar.
      // v15b: a new spin on the same wheel (hand hold, catch, release) keeps
      // the drawn wheel and only turns it — no rebuild ~10× a second.
      const key = String(s.spin.startedAt), sig = s.spin.fields.map((f) => f.title).join("|");
      if (view.dataset.sig !== sig || !view.classList.contains("wheel")) {
        view.dataset.sig = sig; view.dataset.spin = ""; view.className = "screen plain wheel"; view.innerHTML = wheelScreen(s);
        fitAll(view); settleNums(view);
      } else refreshWheelBars(s);
      if (view.dataset.spin !== key) { view.dataset.spin = key; startWheel(s.spin, s.fieldTitle || ""); }
      return;
    }
    view.dataset.spin = ""; view.dataset.sig = "";
    stopWheel();
    // A black box opening at the end: full screen with the drum roll (v13).
    if (!picking && mine && s.boxOpening) {
      view.className = "screen plain box-open";
      view.innerHTML = boxOpeningView(s, s.boxOpening);
      fitAll(view);
      playDrum(s.boxOpening);
      return;
    }
    if (!picking && mine && Date.now() < leftUntil && s.phase === "question") {
      view.className = "screen plain";
      view.innerHTML = `<div class="center-msg"><div class="led big" data-fit="80" data-min="20">${esc(leftText)}</div></div>`;
      fitAll(view);
      return;
    }
    // TV moment after DOBRZE / ŹLE: WYGRANA on the answering team's colour —
    // counts up to the pot (or falls from it to zero), then the accounts jump.
    const r = s.result;
    if (!picking && mine && s.phase === "roundResult" && r && (r.kind === "correct" || r.kind === "wrong")) {
      const key = [s.stage, s.questionNumber, r.kind, r.team, r.amount].join("|");
      if (!seenMoments.has(key)) { seenMoments.add(key); moment = { key, until: Date.now() + (r.kind === "correct" ? 3300 : 4000) }; }
      if (moment && moment.key === key && Date.now() < moment.until) {
        view.className = `screen fill ${tc(r.team)}`;
        view.innerHTML = momentView(s, r);
        fitAll(view); settleNums(view);
        clearTimeout(moment.timer);
        moment.timer = setTimeout(() => { jumpAccounts(); render(); }, moment.until - Date.now() + 20);
        return;
      }
    }
    if (picking || !mine) { view.className = "screen plain pad"; view.innerHTML = picker(s); }
    else if (s.phase === "strike" && s.strike) { view.className = "screen plain strike-screen"; view.innerHTML = strikeView(s); }
    else if (s.phase === "auction") { view.className = "screen plain auction"; view.innerHTML = auction(s); }
    else if (s.phase === "question") { view.className = "screen plain question"; view.innerHTML = question(s); }
    else {
      const t = myTeam(s);
      // Out of the game (bankrupt / not in the final): the darkened team colour.
      const out = t.bankrupt || (s.stage === "final" && !t.playing && t.id !== "masters");
      view.className = `screen fill ${tc(t.id)} ${out ? "out" : ""}`;
      view.innerHTML = home(s, t);
    }
    tickClock();  // fill the clock first: the bar measures real content
    fitAll(view);
    settleNums(view);
  }

  function connecting() {
    return `<div class="center-msg"><div class="led big">AWANTURA O KASĘ</div><div class="fine" id="pickInfo">${esc(infoLine())}</div></div>`;
  }

  // 0. Pick your team.
  function picker(s) {
    const teams = [...teamsOf(s)];
    if (!teamById(s, "masters")) teams.push(MASTERS);
    const tiles = teams.map((t) => `
      <button class="pick ${tc(t.id)} ${t.id === mine ? "on" : ""}" data-id="${t.id}">
        <span class="nm led">${esc(t.name)}</span>
        <span class="sub">${t.id === "masters" && !teamById(s, "masters") ? "GRAJĄ W FINALE" : `KASA ${t.total} ZŁ`}</span>
      </button>`).join("");
    return `<div class="pick-head"><div class="led">KTÓRA TO WASZA DRUŻYNA?</div>${mine ? `<button class="close" data-close>ZAMKNIJ</button>` : ""}</div>
      <div class="picks n${teams.length}">${tiles}</div>
      <div class="fine" id="pickInfo">${esc(infoLine())}</div>`;
  }

  function myTeam(s) { return teamById(s, mine) || (mine === "masters" ? MASTERS : MASTERS); }

  // 1 + 4. No question on screen: my colour edge to edge, my money huge.
  // Top bar = round · category · the other teams · corner button; bottom bar
  // (same look) = what just happened: result, pot, right answer, box, final…
  function home(s, me) {
    // In the final only the finalists matter; teams knocked out stay off the bar.
    const others = teamsOf(s).filter((t) => t.id !== me.id && (s.stage !== "final" || t.playing));
    if (spectator(s)) {
      // Out of the final: not a dead screen — the final as on TV (v13).
      const cells = foot(s, me);
      if (cells.length && !cells.some((c) => c.grow)) cells[cells.length - 1].grow = true;
      return `${bar(s, others)}${effects(s)}
        <div class="hero">
          <div class="mine-label">${s.fieldTitle ? "WYLOSOWANE" : "FINAŁ Z MISTRZAMI"}</div>
          <div class="amount"><span class="led" data-fit="200" data-min="30" data-hbox="hero">${esc(s.fieldTitle || "KOŁO")}</span></div>
          <div class="zl"></div>
        </div>
        ${cells.length ? barOf(cells, "foot") : ""}`;
    }
    const label = me.bankrupt ? "BANKRUT" : "WASZA KASA";
    const probe = "8".repeat(Math.max(4, String(Math.max(me.total, lastNums["me-" + me.id] || 0)).length));
    const cells = foot(s, me);
    // Every bar is filled: if nothing is marked to grow, the last plain cell
    // (or else the last cell) takes the rest — no empty holes.
    if (cells.length && !cells.some((c) => c.grow)) ([...cells].reverse().find((c) => !c.cls) || cells[cells.length - 1]).grow = true;
    return `${bar(s, others)}${effects(s)}
      <div class="hero">
        <div class="mine-label ${me.bankrupt ? "bankrupt" : ""}">${label}</div>
        <div class="amount">${led("me-" + me.id, me.total, `data-fit="320" data-min="40" data-hbox="hero" data-probe="${probe}"`)}</div>
        <div class="zl">ZŁ</div>
      </div>
      ${cells.length ? barOf(cells, "foot") : ""}`;
  }

  // What the host did this round (AKCJE PROWADZĄCEGO) + a bought hint: one bar each.
  function effects(s) {
    const cells = [];
    if (s.question && s.question.hintPaid) cells.push(barOf([{ k: "PODPOWIEDŹ KUPIONA", v: `−${s.question.hintPaid} ZŁ`, cls: "hl" }], "fx"));
    // AKCJE PROWADZĄCEGO this round (v13): KARA red, PREMIA green.
    (s.actions || []).forEach((a) => cells.push(barOf([{ k: a.team ? `${esc(a.label)} · ${esc(nameOf(s, a.team))}` : esc(a.label),
      v: `${a.kind === "penalty" ? "−" : "+"}${a.amount} ZŁ`, cls: a.kind === "penalty" ? "bad" : "good" }], "fx")));
    return cells.join("");
  }
  // 1 NA 1 with crossing out: the list, crossed-out ones dimmed, whose turn.
  function strikeView(s) {
    const st = s.strike;
    // 3 per row, lines only between cells (container gap), safe-area padding on the outer cells.
    const n = st.options.length, last = n - (n % 3 || 3);
    const items = st.options.map((o, i) => {
      const edge = [i % 3 === 0 ? "l" : "", i % 3 === 2 || i === n - 1 ? "r" : "", i >= last ? "b" : ""].join(" ");
      return `<div class="sk ${edge} ${st.struck.includes(o) ? "out" : ""}"><span class="led">${esc(o)}</span></div>`;
    }).join("");
    return `${barOf([roundCell(s), { k: "1 NA 1 · SKREŚLAJĄ", v: esc(nameOf(s, st.turn)), cls: `team ${tc(st.turn)}`, grow: true }], "top")}
      <div class="strike">${items}</div>`;
  }

  let moment = null;
  const seenMoments = new Set();
  function momentView(s, r) {
    const won = r.kind === "correct";
    const from = won ? 0 : r.amount, to = won ? r.amount : 0;
    return `${bar(s, [])}
      <div class="hero">
        <div class="mine-label">${won ? "WYGRANA" : "ŹLE · " + esc(nameOf(s, r.team) || "NIKT")}</div>
        <div class="amount"><span class="led" data-num="moment" data-target="${to}" data-from="${from}" data-dur="${won ? 1500 : 3000}" data-delay="${won ? 200 : 600}"
          data-fit="320" data-min="40" data-hbox="hero" data-probe="${"8".repeat(Math.max(4, String(r.amount).length))}">${from}</span></div>
        <div class="zl">${won ? "DOBRZE" : r.amount > 0 ? "PULA PRZECHODZI DALEJ" : "PULA BYŁA PUSTA"}</div>
      </div>`;
  }
  // After the moment the accounts jump to the new values (no counting), like on TV.
  function jumpAccounts() {
    if (!state) return;
    teamsOf(state).forEach((t) => { lastNums["me-" + t.id] = t.total; lastNums["o-" + t.id] = t.total; });
    lastNums.moment = undefined;
  }

  // What happened, from MY team's point of view — cells for the bottom bar.
  function foot(s, me) {
    const out = [];
    const isMe = (id) => id && id === me.id;
    const N = (id) => esc(nameOf(s, id));
    const answer = (r) => r.correctAnswer && out.push({ k: "POPRAWNA ODPOWIEDŹ", v: esc(r.correctAnswer), grow: true });
    // Each fact in one place: round / category / other teams live in the top
    // bar, my team is the colour of the screen — none of it is repeated here.
    switch (s.phase) {
      case "roundResult": {
        const r = s.result;
        if (!r) break;
        const who = isMe(r.team) ? "WYNIK" : r.team ? `WYNIK · ${N(r.team)}` : "NIKT NIE ODPOWIEDZIAŁ";
        if (r.kind === "correct") {
          out.push({ k: who, v: "DOBRZE", cls: "good" });
          out.push(isMe(r.team) ? { k: "WYGRYWACIE PULĘ", v: r.amount, n: "ev-win", sign: true } : { k: "WYGRYWAJĄ PULĘ", v: r.amount, n: "ev-win" });
          answer(r);
        } else if (r.kind === "wrong") {
          out.push({ k: who, v: "ŹLE", cls: "bad" });
          out.push(r.amount > 0 ? { k: "PULA PRZECHODZI DALEJ", v: r.amount, n: "ev-carry" } : { k: "PULA", v: "BYŁA PUSTA" });
          answer(r);
        } else if (r.kind === "hint") {        // field PODPOWIEDŹ (named in the top bar): won a free hint
          out.push(isMe(r.team) ? { k: "WYNIK", v: "MACIE JĄ NA PÓŹNIEJ", cls: "good" } : { k: "NA PÓŹNIEJ DLA", v: N(r.team) });
          out.push(isMe(r.team) ? { k: "ZAPŁACILIŚCIE", v: -r.amount, n: "ev-paid" } : { k: "ZAPŁACILI", v: r.amount, n: "ev-paid" });
        } else if (r.kind === "box") {         // CZARNA SKRZYNKA is already the top bar category
          if (isMe(r.team)) {
            out.push({ k: "ZAPŁACILIŚCIE", v: -r.amount, n: "ev-paid", cls: "box" });
            out.push({ k: "CO W ŚRODKU?", v: "DOWIECIE SIĘ NA KOŃCU GRY", grow: true });
          } else {
            out.push({ k: "KUPUJĄ", v: N(r.team), cls: "box" });
            out.push({ k: "ZAPŁACILI", v: r.amount, n: "ev-paid" });
          }
        }
        break;
      }
      case "stageEnd":   // "KONIEC ETAPU 1" is the round cell on top
        out.push(isMe(s.winner) ? { k: "WYNIK", v: "GRACIE W FINALE Z MISTRZAMI!", cls: "good", grow: true } : { k: "DO FINAŁU IDĄ", v: N(s.winner) });
        break;
      case "gameEnd": {  // "KONIEC GRY" is the round cell on top
        const w = s.winner;
        if (isMe(w)) out.push({ k: "WYNIK", v: w === "masters" ? "OBRONILIŚCIE TYTUŁ!" : s.stage === "final" ? "JESTEŚCIE NOWYMI MISTRZAMI!" : "WYGRALIŚCIE!", cls: "good", grow: true });
        else if (w) out.push(w === "masters" ? { k: "WYNIK", v: "MISTRZOWIE OBRONILI TYTUŁ" } : { k: "WYGRYWAJĄ", v: N(w) });
        s.boxes.filter((b) => isMe(b.owner)).forEach((b) =>
          out.push({ k: "CZARNA SKRZYNKA", v: b.open ? esc(b.prize) : "JESZCZE ZAMKNIĘTA", cls: "box", grow: true }));
        break;
      }
    }
    // Hero already says BANKRUT; the bar says what it means (not after the stage: v13).
    if (me.bankrupt && s.phase !== "gameEnd" && s.phase !== "stageEnd") out.push({ k: "MNIEJ NIŻ 300 ZŁ", v: "NIE LICYTUJECIE", cls: "bad" });
    // The finalists are the tiles on top; we watch the final.
    if (spectator(s)) out.push({ v: "KIBICUJECIE" });
    // A free hint won on the wheel waits for us (v13).
    if (me.hintTokens > 0 && s.phase !== "gameEnd") out.push({ k: "MACIE", v: me.hintTokens > 1 ? `PODPOWIEDŹ ×${me.hintTokens}` : "PODPOWIEDŹ" });
    if (me.id === "masters" && !teamById(s, "masters")) out.push({ v: "CZEKACIE NA FINAŁ" });
    return out;
  }

  // 2. Auction: team columns (KONTO over OFERTA), PULA bar underneath. No team
  // names: the colour says whose column it is; tap another column = become that team.
  // Bids seen last time: a team that just went up and leads gets a short pulse.
  let prevBids = {};
  // TV-style (Arek, v11): the leading offer is the one lit in full colour, the
  // other offers sit dimmed (dark team colour, light digits); a team that is
  // out (bankrupt / not bidding / BLOKADA) is darker still with a small word.
  function auction(s) {
    const teams = s.teams.filter((t) => t.playing);
    const pulsed = new Set(teams.filter((t) => t.leading && prevBids[t.id] != null && t.bid > prevBids[t.id]).map((t) => t.id));
    prevBids = Object.fromEntries(teams.map((t) => [t.id, t.bid]));
    const probe = "8".repeat(Math.max(4, String(Math.max(...teams.map((x) => x.bid))).length));
    const cols = teams.map((t) => {
      const state = !t.inAuction ? (t.bankrupt ? "BANKRUT" : "NIE LICYTUJE") : t.blocked ? "BLOKADA" : t.vaBanque ? "VA BANQUE" : "";
      const bid = t.inAuction
        ? `<span class="led" data-num="bid-${t.id}" data-target="${t.bid}" data-fit="120" data-min="18" data-fit-group="bids" data-probe="${probe}">${t.bid}</span>`
        : "";
      const cls = !t.inAuction || t.blocked ? "out" : t.leading || t.vaBanque ? "lead" : "";
      return `<div class="col ${tc(t.id)} ${t.id === mine ? "mine" : ""}" ${t.id !== mine ? `data-id="${t.id}"` : ""}>
        <div class="konto">${t.id === mine ? `<span class="k">WASZE KONTO</span>` : ""}<span class="v led" data-num="bal-${t.id}" data-target="${t.balance}">${t.balance}</span></div>
        <div class="offer ${cls} ${t.vaBanque ? "vb" : ""} ${pulsed.has(t.id) && !t.vaBanque ? "pulse" : ""}"
             aria-label="${esc(t.name)}: ${t.inAuction ? `oferta ${t.bid} zł` : state.toLowerCase()}${t.leading ? ", prowadzi" : ""}">
          <div class="ov">${bid}</div>
          ${state ? `<div class="st">${state}</div>` : ""}
        </div>
      </div>`;
    }).join("");
    return `${spectator(s) ? barOf([roundCell(s), { v: s.fieldTitle ? esc(s.fieldTitle) : "", grow: true }, { v: "KIBICUJECIE", cls: "hl" }], "top") : bar(s)}${effects(s)}
      <div class="cols n${teams.length}">${cols}</div>
      ${barOf([{ k: s.bankAuction && s.pot > 0 ? "PULA · NIE GRA TERAZ" : "PULA", v: s.pot, n: "pot" }], "foot pot")}`;
  }


  // 3. Question: one low bar "PULA 7300 ——— CZAS 0:51", the question big in the
  // answering team's colour, A–D in a 2×2 grid.
  function question(s) {
    const q = s.question;
    const id = q.duel ? null : q.team;
    let who = q.duel ? `1 NA 1 · ${esc(q.category)} · KTO PIERWSZY, TEN ODPOWIADA` : id === mine ? "ODPOWIADACIE!" : spectator(s) ? "KIBICUJECIE" : "";
    // v16: before START CZASU the category goes with "PYTANIE ZA CHWILĘ".
    if (q.waiting && !q.duel) who = who ? `${esc(q.category)} · ${who}` : esc(q.category);
    const answers = q.answers
      ? `<div class="answers">${q.answers.map((a, i) => `<div class="a"><span class="chip led">${"ABCD"[i]}</span><span class="tx">${esc(a)}</span></div>`).join("")}</div>` : "";
    const haggle = q.hintOffer ? barOf([{ v: `PODPOWIEDŹ ZA ${q.hintOffer} ZŁ?`, cls: "hl" }], "haggle") : "";
    // TV: the bar in the answering team's colour with DO WYGRANIA, the clock apart.
    return `${barOf([
        { k: "DO WYGRANIA", v: s.pot + " ZŁ", cls: `team ${tc(id)}`, at: "start", grow: true },
        { k: "", kid: "clockLbl", v: "", vid: "clockNum", at: "end", attrs: 'id="clock"' },
      ], "top qbar")}
      ${effects(s)}${haggle}
      <div class="q ${tc(id)} ${q.duel ? "duel" : ""}">
        ${who ? `<div class="who ${id === mine && !q.duel ? "mine" : ""}">${who}</div>` : ""}
        ${q.waiting ? `<div class="qtext qwait"><span class="led" data-fit="90" data-min="15">PYTANIE ZA CHWILĘ</span></div>`
          : `<div class="qtext"><span data-fit="90" data-min="15">${esc(q.text)}</span></div>`}
        ${answers}
      </div>`;
  }

  // Local countdown (the host's phone is the truth; snapshots re-sync it).
  function tickClock() {
    const c = $("clock");
    if (!c || !state || !state.question || !clock) return;
    const q = state.question;
    const left = clock.running ? Math.max(0, clock.left - Math.floor((Date.now() - clock.at) / 1000)) : clock.left;
    const t = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    let n = $("clockNum");
    if (!n) { c.insertAdjacentHTML("beforeend", `<span class="v led" id="clockNum"></span>`); n = $("clockNum"); }
    if (n.textContent !== t) n.textContent = t;
    // v13: the clock waits until the host has read the question (START CZASU).
    $("clockLbl").textContent = q.hintOffer ? "ZEGAR STOI" : q.waiting ? "CZEKA" : clock.running && left > 0 ? "CZAS" : left === 0 ? "KONIEC CZASU" : "PAUZA";
    c.className = "cell at-end" + (left === 0 ? " bad zero" : left <= 10 && !q.hintOffer ? " bad" : "");
  }
  setInterval(tickClock, 200);

  // ?debug=1&inset=62,20: fake the iPhone safe area in desktop browsers (screenshots).
  if (debug && /^\d+,\d+$/.test(params.get("inset") || "")) {
    const [side, bottom] = params.get("inset").split(",");
    document.documentElement.style.setProperty("--sal", side + "px");
    document.documentElement.style.setProperty("--sar", side + "px");
    document.documentElement.style.setProperty("--sab", bottom + "px");
  }
  // ?debug=1: feed a hand-made snapshot (screenshots / QA of rare screens).
  if (debug) window.__awantura.inject = (p, team) => {
    if (team) { mine = team; picking = false; }
    if (!hostId) hostId = "debug";
    lastSentAt = 0; onSnapshot({ ...p, code, hostId, sentAt: Date.now() });
  };

  // ---- black box opening (end of the game), full screen ---------------------
  function boxOpeningView(s, b) {
    const name = esc(nameOf(s, b.owner));
    const body = b.prize
      ? `<div class="mine-label">W ŚRODKU JEST</div>
         <div class="amount"><span class="led" data-fit="120" data-min="18" data-hbox="hero">${esc(b.prize)}</span></div>
         <div class="zl">NAGRODA DODATKOWA · NIE ZMIENIA WYNIKU GRY</div>`
      : `<div class="mine-label">OTWIERAMY…</div><div class="amount"><span class="led drum">…</span></div><div class="zl"></div>`;
    return `${barOf([{ k: "CZARNA SKRZYNKA", v: name, cls: `team ${tc(b.owner)}`, grow: true }], "top")}<div class="hero">${body}</div>`;
  }
  // The drum roll like in the app (best effort: browsers may block sound
  // until the screen was touched once).
  let drum = null, drumFor = null;
  function playDrum(b) {
    if (b.prize || drumFor === b.startedAt) return;
    drumFor = b.startedAt;
    try {
      drum = drum || new Audio("drumroll.mp3");
      drum.currentTime = 0;
      drum.play().catch(() => {});
    } catch (_) {}
  }

  // ---- the wheel (live from the host) ---------------------------------------
  // The spin comes as data (fields, disc angle under the pointer from → to,
  // start time, duration): this phone turns its own SVG wheel with the same
  // ease-out-quart curve, in sync. Half wheel anchored at the bottom, pointer on
  // top; the field under the pointer runs through the category cell.
  let skew = 0, wheelRAF = 0;
  const quart = (u) => 1 - Math.pow(1 - u, 4);
  // v15: a hand spin slows down with constant friction (ease-out quad).
  const quad = (u) => 1 - (1 - u) * (1 - u);
  // v17 (Arek — like the TV wheel): category wedges deep indigo / light
  // lavender in turn (never the teams' colours), PODPOWIEDŹ dark green,
  // 1 NA 1 turquoise, CZARNA SKRZYNKA black. Same rule as WheelColors in the app.
  const WHEEL_HEX = ["#3e3a9a", "#f3eef8"], WHEEL_INK = ["#f3eef8", "#3e3a9a"];
  function wheelColors(fields) {
    let k = 0;
    return fields.map((f) => (f.kind === "category" ? k++ % 2 : null));
  }
  function wedgeStyle(f, color) {
    if (f.kind === "category") return { fill: WHEEL_HEX[color || 0], ink: WHEEL_INK[color || 0] };
    if (f.kind === "hint") return { fill: "#2e7d32", ink: "#fff" };
    if (f.kind === "blackBox") return { fill: "#050505", ink: "#fff", box: true };
    return { fill: "#25a9c9", ink: "#000" };  // 1 NA 1
  }
  // A ring band round the pointer direction (+x): radii r0…r1, half-angle h (rad).
  function band(r0, r1, h) {
    const p = (r, a) => `${(Math.cos(a) * r).toFixed(4)} ${(Math.sin(a) * r).toFixed(4)}`;
    return `M${p(r1, -h)} A${r1} ${r1} 0 0 1 ${p(r1, h)} L${p(r0, h)} A${r0} ${r0} 0 0 0 ${p(r0, -h)} Z`;
  }
  function wheelSVG(sp) {
    const n = sp.fields.length, seg = 360 / n, rim = 0.93, segRad = seg * Math.PI / 180;
    const pt = (deg, r) => { const a = (deg - 90) * Math.PI / 180; return [Math.cos(a) * r, Math.sin(a) * r]; };
    const colors = wheelColors(sp.fields);
    let wedges = "", labels = "", bulbs = "";
    // Labels like the TV: one common size (the median fit), smaller only when
    // a long title would not fit its narrow wedge. LED glyph ≈ 0.70 em wide.
    const inner = 0.23, outer = rim - 0.03, sh = Math.sin(segRad / 2), kk = 0.72;
    const fit = (t) => { const m = t.length * 0.70; return Math.min(0.075, (outer - inner) / m, 2 * outer * sh * kk / (1 + 2 * m * sh * kk)); };
    const sizes = sp.fields.map((f) => fit(f.title)), common = [...sizes].sort((a, b) => a - b)[Math.floor(sizes.length / 2)];
    sp.fields.forEach((f, i) => {
      const st = wedgeStyle(f, colors[i]);
      const [x0, y0] = pt(i * seg, rim), [x1, y1] = pt((i + 1) * seg, rim);
      wedges += `<path d="M0 0 L${x0} ${y0} A${rim} ${rim} 0 0 1 ${x1} ${y1} Z" fill="${st.fill}" stroke="#1c1c1e" stroke-width=".004" data-i="${i}"/>`;
      if (st.box) wedges += `<path d="M0 0 L${x0} ${y0} A${rim} ${rim} 0 0 1 ${x1} ${y1} Z" fill="none" stroke="#fff" stroke-width=".005" transform="scale(.97)"/>`;
      const mid = i * seg + seg / 2, size = Math.min(common, sizes[i]);
      labels += `<text transform="rotate(${mid - 90}) translate(${outer} 0)" fill="${st.ink}" font-size="${size.toFixed(4)}" text-anchor="end" dominant-baseline="central">${esc(f.title)}</text>`;
    });
    for (let k = 0; k < n; k++) {
      const [x, y] = pt(k * seg, 0.965);
      bulbs += `<circle cx="${x}" cy="${y}" r=".012" fill="${k % 2 ? "#8e8e93" : "#f2f2f7"}"/>`;
    }
    const h = segRad / 2, win = band(0.24, 0.955, h);
    const line = (s) => { const a = s * h; return `<line x1="${Math.cos(a) * .26}" y1="${Math.sin(a) * .26}" x2="${Math.cos(a) * .95}" y2="${Math.sin(a) * .95}" stroke="#ffe45c" stroke-width=".006"/>`; };
    // The wheel seen from the side (v16) with the TV pointer (v17): a black
    // fork along the radius, a window one wedge wide with yellow LED lines,
    // lit a little once the result is in. Flat — no glow.
    return `<svg class="wheel-svg" viewBox="-.46 -.59 2.09 1.18" preserveAspectRatio="xMinYMid meet">
      <g id="disc">
        <circle r="1" fill="#1c1c1e" stroke="#636366" stroke-width=".004"/>
        ${wedges}<g class="wl">${labels}</g>${bulbs}
      </g>
      <path id="winLit" d="${win}" fill="#fff" fill-opacity=".12" style="display:none"/>
      <path d="${band(0.2, 0.985, h * 1.8)} ${win}" fill="#000" fill-rule="evenodd"/>
      <path d="${band(0.94, 1.08, h * 2.2)}" fill="#000"/>
      ${line(-1)}${line(1)}
      <circle r=".2" fill="#000"/>
    </svg>`;
  }
  // v16: the wheel fills the screen; ONE bar on top (RUNDA | the field) and
  // the accounts at the bottom (every team + PULA, like the host's strip),
  // both solid black with a 1 px frame, floating over the wheel.
  function wheelScreen(s) {
    return `<div class="wheel-area">${wheelSVG(s.spin)}
      <div class="bar wtop">${cell({ ...roundCell(s), attrs: 'id="wround"' })}<div class="cell grow"><span class="v led" id="wheelTicker"></span></div></div>
      <div class="wfoot" id="wfoot">${wheelFoot(s)}</div></div>`;
  }
  function wheelFoot(s) {
    const teams = teamsOf(s).filter((t) => t.id !== "masters" || s.stage === "final").filter((t) => s.stage !== "final" || t.playing);
    return barOf([...teams.map((t) => ({ ...teamCell(t), grow: true })), { k: "PULA", v: s.pot, n: "pot" }]);
  }
  // Same wheel, new snapshot (accounts, round): refresh the bars only.
  function refreshWheelBars(s) {
    const f = document.getElementById("wfoot"), r = document.getElementById("wround");
    if (f) { f.innerHTML = wheelFoot(s); fitAll(f); settleNums(f); }
    if (r) r.outerHTML = cell({ ...roundCell(s), attrs: 'id="wround"' });
  }
  // `idle`: the title when the wheel stands with no result yet (v16: empty).
  function startWheel(sp, idle = "") {
    stopWheel();
    const disc = document.getElementById("disc"), seg = 360 / sp.fields.length;
    const t0 = sp.startedAt + skew, dur = sp.duration * 1000;
    // v15b "hold": the host holds the wheel (≈10 updates/s, eased by CSS);
    // v16 "rest": the wheel stands, no result yet (no lit wedge, no title).
    const hold = sp.curve === "hold", rest = sp.curve === "rest";
    if (disc) disc.style.transition = hold ? "transform 120ms linear" : "none";
    const win0 = document.getElementById("winLit"); if (win0) win0.style.display = "none";
    let lastTitle = null;
    const show = (title) => { if (title !== lastTitle) { lastTitle = title; const t = document.getElementById("wheelTicker"); if (t) t.textContent = title; } };
    const frame = () => {
      const u = Math.max(0, Math.min(1, (Date.now() - t0) / dur));
      const off = sp.from + (sp.to - sp.from) * (sp.curve === "quad" ? quad(u) : quart(u));
      // Pointer on the right (90°, like the host's WheelLayout.left).
      if (disc) disc.style.transform = `rotate(${90 - off}deg)`;
      const idx = Math.floor((((off % 360) + 360) % 360) / seg) % sp.fields.length;
      if (rest) { show(idle); return; }
      if (u < 1 || hold) { show(sp.fields[idx].title); if (u < 1) wheelRAF = requestAnimationFrame(frame); return; }
      // stopped: light the drawn wedge, show its name
      const win = document.getElementById("winLit"); if (win) win.style.display = "";
      show(sp.fields[sp.landed].title);
    };
    wheelRAF = requestAnimationFrame(frame);
  }
  function stopWheel() { cancelAnimationFrame(wheelRAF); }

  // ---- taps: switch team (no corner button, no confirmation) -------------------
  $("view").addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) { picking = false; render(); return; }
    // Picker tiles, team tiles on the top bar, other teams' auction columns.
    const b = e.target.closest("[data-id]");
    if (b) {
      mine = b.dataset.id;
      localStorage.setItem("awantura.mine", mine);
      picking = false;
      render();
    }
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

  render();
  setStatus("connecting");
})();
