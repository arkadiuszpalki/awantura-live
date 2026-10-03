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
      sock.onopen = () => { backoff = 400; lastMsgAt = Date.now(); setStatus(state ? "live" : "wait"); };
      sock.onmessage = (e) => {
        let p; try { p = JSON.parse(e.data); } catch (_) { return; }
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
    // Clock: counted down on this phone, re-synced by every snapshot.
    const q = p.question;
    if (q) {
      if (!clock || clock.left !== q.timeLeft || clock.running !== (q.timerRunning && !q.hintOffer)) {
        clock = { left: q.timeLeft, running: q.timerRunning && !q.hintOffer, at: Date.now() };
      }
    } else clock = null;
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
    document.querySelectorAll(".me-btn").forEach((b) => b.dataset.status = kind);
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
  const tweens = new Map();
  function num(el, value) {
    const from = Number(el.dataset.v ?? value);
    el.dataset.v = value;
    if (from === value) { el.textContent = fmt(value, el); return; }
    const d = Math.min(2200, Math.max(350, Math.abs(value - from) / 2.5));
    const t0 = performance.now();
    cancelAnimationFrame(tweens.get(el));
    const step = (t) => {
      const u = Math.min(1, (t - t0) / d);
      const e = 1 - Math.pow(1 - u, 3);
      el.textContent = fmt(Math.round(from + (value - from) * e), el);
      if (u < 1) tweens.set(el, requestAnimationFrame(step));
    };
    tweens.set(el, requestAnimationFrame(step));
  }
  const fmt = (v, el) => (el.dataset.sign && v > 0 ? "+" : "") + v;
  // Re-rendered markup carries data-num="key"; values persist across renders.
  const lastNums = {};
  function settleNums(root) {
    root.querySelectorAll("[data-num]").forEach((el) => {
      const k = el.dataset.num, v = Number(el.dataset.target);
      if (Number.isNaN(v)) return;
      const from = el.dataset.from != null && lastNums[k] !== v ? Number(el.dataset.from) : null;
      el.dataset.v = from ?? lastNums[k] ?? v;
      el.textContent = fmt(Number(el.dataset.v), el);
      num(el, v);
      lastNums[k] = v;
    });
  }

  // ---- fit text to its box (like SwiftUI minimumScaleFactor) ------------------
  // <span data-fit="max px" data-min="min px">: largest size that fits the parent.
  // Last first: the news lines settle their height before the big amount fills what is left.
  function fitAll(root) {
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
      let lo = Number(el.dataset.min || 10), hi = Number(el.dataset.fit);
      const fits = (s) => { el.style.fontSize = s + "px"; return el.offsetWidth <= W + 0.5 && el.scrollWidth <= el.offsetWidth + 1 && el.offsetHeight <= H + 0.5; };
      if (!fits(lo)) { el.style.fontSize = lo + "px"; el.textContent = shown; return; }
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (fits(mid)) lo = mid; else hi = mid; }
      el.style.fontSize = lo + "px";
      el.textContent = shown;
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
  const roundText = (s) =>
    s.phase === "gameEnd" ? "KONIEC GRY" : s.phase === "stageEnd" ? "KONIEC ETAPU 1"
    : s.phase === "setup" ? "PRZED STARTEM"
    : `${s.stage === "final" ? "FINAŁ" : "RUNDA"} ${s.bonus ? "BONUSOWA" : `${s.questionNumber}/${s.rounds}`}`;
  const meBtn = () => `<button class="me-btn ${tc(mine)}" data-pick data-status="${statusKind}" aria-label="Zmień drużynę"><span class="sq"></span><span class="dot"></span></button>`;

  // Top bar: round · category · corner button.
  function bar(s, extra = "") {
    return `<div class="bar">
      <div class="cell led round">${esc(roundText(s))}</div>
      <div class="cell led cat">${s.fieldTitle ? `<span data-fit="22" data-min="11">${esc(s.fieldTitle)}</span>` : ""}</div>
      ${extra}${meBtn()}
    </div>`;
  }

  // ---- render -------------------------------------------------------------
  function render() {
    const view = $("view");
    const s = state;
    if (!s) { view.className = "screen plain pad"; view.innerHTML = connecting(); return; }
    if (picking || !mine) { view.className = "screen plain pad"; view.innerHTML = picker(s); }
    else if (s.phase === "auction") { view.className = "screen plain auction"; view.innerHTML = auction(s); }
    else if (s.phase === "question") { view.className = "screen plain question"; view.innerHTML = question(s); }
    else { const t = myTeam(s); view.className = `screen fill ${tc(t.id)}`; view.innerHTML = home(s, t); }
    fitAll(view);
    settleNums(view);
    tickClock();
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
    const others = teamsOf(s).filter((t) => t.id !== me.id && (s.stage !== "final" || t.playing)).map((t) => `
      <div class="other ${tc(t.id)} ${t.bankrupt ? "bankrupt" : ""}"><span class="nm">${esc(t.name)}${t.bankrupt ? " · BANKRUT" : ""}</span>${led("o-" + t.id, t.total)}</div>`).join("");
    const label = me.bankrupt ? "BANKRUT" : "WASZA KASA";
    const probe = "8".repeat(Math.max(4, String(Math.max(me.total, lastNums["me-" + me.id] || 0)).length));
    const cells = foot(s, me);
    // Nothing marked to fill the bar: the last plain (uncoloured) cell takes the
    // rest; only coloured cells → an empty cell fills it (like the top bar).
    if (cells.length && !cells.some((c) => c.grow)) {
      const plain = [...cells].reverse().find((c) => !c.cls);
      if (plain) plain.grow = true; else cells.push({ empty: true });
    }
    return `${bar(s, others ? `<div class="others">${others}</div>` : "")}
      <div class="hero">
        <div class="mine-label ${me.bankrupt ? "bankrupt" : ""}">${label}</div>
        <div class="amount">${led("me-" + me.id, me.total, `data-fit="320" data-min="40" data-hbox="hero" data-probe="${probe}"`)}</div>
        <div class="zl">ZŁ</div>
      </div>
      ${cells.length ? `<div class="bar foot">${cells.map(footCell).join("")}</div>` : ""}`;
  }

  // One bottom-bar cell: small label over a value (LED, like the other teams'
  // tiles in the top bar). n = animated LED number; tx = content text (answers,
  // box prizes) in the system font like the question; grow = takes the rest.
  function footCell(c) {
    if (c.empty) return `<div class="cell kv grow"></div>`;
    const v = c.n
      ? `<span class="led v" data-num="${c.n}" data-target="${c.v}" ${c.sign ? 'data-sign="1"' : ""}>${c.v}</span>`
      : c.grow
        ? `<span class="vb"><span class="v ${c.tx ? "tx" : "led"}" data-fit="${c.tx ? 17 : 19}" data-min="9">${c.v}</span></span>`
        : `<span class="v led">${c.v}</span>`;
    return `<div class="cell kv ${c.cls || ""} ${c.grow ? "grow" : ""}">${c.k ? `<span class="k">${c.k}</span>` : ""}${v}</div>`;
  }

  // What happened, from MY team's point of view — cells for the bottom bar.
  function foot(s, me) {
    const out = [];
    const isMe = (id) => id && id === me.id;
    const N = (id) => esc(nameOf(s, id));
    const answer = (r) => r.correctAnswer && out.push({ k: "POPRAWNA ODPOWIEDŹ", v: esc(r.correctAnswer), tx: true, grow: true });
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
          out.push({ k: "CZARNA SKRZYNKA", v: b.open ? esc(b.prize) : "JESZCZE ZAMKNIĘTA", tx: b.open, cls: "box", grow: true }));
        break;
      }
    }
    // Hero already says BANKRUT; the bar says what it means.
    if (me.bankrupt && s.phase !== "gameEnd") out.push({ k: "MNIEJ NIŻ 300 ZŁ", v: "NIE LICYTUJECIE", cls: "bad" });
    // The finalists are the tiles on top; only say that we sit this one out.
    if (!me.playing && s.stage === "final" && s.phase !== "gameEnd" && me.id !== "masters") out.push({ v: "NIE GRACIE W FINALE" });
    if (me.id === "masters" && !teamById(s, "masters")) out.push({ v: "CZEKACIE NA FINAŁ" });
    return out;
  }

  // 2. Auction: KONTO / OFERTA columns, PULA underneath.
  function auction(s) {
    const teams = s.teams.filter((t) => t.playing);
    const cols = teams.map((t) => {
      const probe = "8".repeat(Math.max(4, String(Math.max(...teams.map((x) => x.bid))).length));
      const bid = t.inAuction
        ? `<span class="led" data-num="bid-${t.id}" data-target="${t.bid}" data-fit="120" data-min="18" data-probe="${probe}">${t.bid}</span>`
        // Out of the auction the tile loses its colour, so the name says whose it is.
        : `<span class="out-t">${esc(t.name)}<br>${t.bankrupt ? "BANKRUT" : "NIE LICYTUJE"}</span>`;
      return `<div class="col ${tc(t.id)} ${t.id === mine ? "mine" : ""}">
        <div class="konto"><span class="lbl">${t.id === mine ? "WASZE KONTO" : "KONTO"}</span>${led("bal-" + t.id, t.balance)}</div>
        <div class="offer ${t.inAuction ? "" : "out"} ${t.leading ? "lead" : ""} ${t.vaBanque ? "vb" : ""}">
          <div class="ol">${t.leading ? "PROWADZI" : t.inAuction ? "OFERTA" : ""}</div>
          <div class="ov">${bid}</div>
          ${t.vaBanque ? `<div class="ol vb">VA BANQUE</div>` : ""}
        </div>
      </div>`;
    }).join("");
    return `${bar(s)}
      <div class="cols n${teams.length}">${cols}</div>
      <div class="pot ${s.bankAuction ? "bank" : ""}"><span class="lbl">${s.bankAuction ? "PULA (NIE GRA TERAZ)" : "PULA"}</span>${led("pot", s.pot)}</div>`;
  }

  // 3. Question: PULA ——— CZAS, the question big in the answering team's colour.
  function question(s) {
    const q = s.question;
    const id = q.duel ? null : q.team;
    const who = q.duel ? "1 NA 1 · KTO PIERWSZY, TEN ODPOWIADA" : id === mine ? "ODPOWIADACIE!" : "";
    const answers = q.answers
      ? `<div class="answers">${q.answers.map((a, i) => `<div class="a"><span class="chip led">${"ABCD"[i]}</span><span class="tx">${esc(a)}</span></div>`).join("")}</div>` : "";
    const haggle = q.hintOffer ? `<div class="haggle"><span>TARGUJEMY PODPOWIEDŹ</span><b class="led">${q.hintOffer} ZŁ</b></div>` : "";
    return `<div class="qbar">
        <div class="cell qpot"><span class="lbl">PULA</span>${led("pot", s.pot)}</div>
        <div class="cell clock" id="clock"><span class="lbl" id="clockLbl"></span><span class="led" id="clockNum"></span></div>
        ${meBtn()}
      </div>
      ${haggle}
      <div class="q ${tc(id)} ${q.duel ? "duel" : ""}">
        ${who ? `<div class="who">${who}</div>` : ""}
        <div class="qtext"><span data-fit="64" data-min="15">${esc(q.text)}</span></div>
        ${answers}
      </div>`;
  }

  // Local countdown (the host's phone is the truth; snapshots re-sync it).
  function tickClock() {
    const n = $("clockNum");
    if (!n || !state || !state.question || !clock) return;
    const q = state.question;
    const left = clock.running ? Math.max(0, clock.left - Math.floor((Date.now() - clock.at) / 1000)) : clock.left;
    if (n.textContent !== String(left)) n.textContent = left;
    $("clockLbl").textContent = q.hintOffer ? "ZEGAR STOI" : clock.running && left > 0 ? "CZAS" : left === 0 ? "KONIEC CZASU" : "PAUZA";
    $("clock").className = "cell clock" + (left === 0 ? " zero" : left <= 10 ? " low" : "") + (q.hintOffer ? " stopped" : "");
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

  // ---- taps: corner button / picker ---------------------------------------------
  $("view").addEventListener("click", (e) => {
    if (e.target.closest("[data-pick]")) { picking = true; render(); return; }
    if (e.target.closest("[data-close]")) { picking = false; render(); return; }
    const b = e.target.closest("button[data-id]");
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
