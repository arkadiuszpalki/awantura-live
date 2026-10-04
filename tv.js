// Awantura o kasę — TV "studio" screen in a browser (smart TV, laptop on a
// projector, the Mac sandbox). Web twin of Awantura/Views/StudioView.swift:
// same PublicGameState, same transport as the players' page (app.js), no
// "my team" — all teams equal. Read only.
//
//   tv.html?k=KOD&w=8738          WI-FI: page served by the host phone, WebSocket to the same host
//   tv.html?k=KOD&w=8738&h=<ip>   WI-FI, page served elsewhere (Mac sandbox): WebSocket to <ip>
//   tv.html?k=KOD                 INTERNET: Supabase Realtime Broadcast "awantura:<KOD>"
//
// Layout (1 unit = 1 px of a 1080p TV, see tv.css --u):
//   edge to edge, 1 px lines only between bands (v11, like StudioView):
//   top bar  RUNDA · category · PULA (question: DO WYGRANIA on the team colour + CZAS)
//   effects  AKCJE PROWADZĄCEGO (KARA, PREMIA…) and a bought hint
//   tiles    each playing team's account on its colour (no names)
//   panel    by phase: auction offers / 1 NA 1 crossing out / question card /
//            WYGRANA counter + verdict bar / end (headline + boxes)
//   spin     the wheel turning on the host's phone, full screen, live
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
  window.__awanturaTV = { last: null };

  if (!ALPHABET.test(code)) {
    $("nocode").hidden = false;
    $("codeForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const c = $("codeInput").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!ALPHABET.test(c)) return;
      const q = new URLSearchParams(location.search); q.set("k", c);
      location.search = "?" + q.toString();
    });
    return;
  }

  // ---- transport (same as app.js) ---------------------------------------------
  const hostKey = "awantura.tvhost." + code;
  let hostId = sessionStorage.getItem(hostKey);
  let lastSentAt = 0, lastMsgAt = 0, state = null, statusKind = "connecting", skew = 0;
  let clock = null;  // { left, running, at } — counted down here, re-synced by every snapshot
  const wsPort = /^\d{2,5}$/.test(params.get("w") || "") ? params.get("w") : null;
  const wsHost = /^[A-Za-z0-9.:-]+$/.test(params.get("h") || "") ? params.get("h") : location.hostname;

  if (wsPort) connectLocal(); else connectInternet();

  function connectLocal() {
    let backoff = 400, sock = null, timer = 0;
    const open = () => {
      clearTimeout(timer);
      if (sock && sock.readyState <= 1) return;
      sock = new WebSocket(`ws://${wsHost}:${wsPort}/`);
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
        if (p && p.hb) { lastMsgAt = Date.now(); if (state && statusKind === "stale") setStatus("live"); tellParent({ hb: 1, code }); return; }
        onSnapshot(p);
      };
      sock.onclose = () => { setStatus("off"); timer = setTimeout(open, backoff); backoff = Math.min(backoff * 2, 3000); };
      sock.onerror = () => { try { sock.close(); } catch (_) {} };
    };
    open();
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { backoff = 400; open(); } });
  }

  function connectInternet() {
    const tag = document.createElement("script");
    tag.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.min.js";
    tag.onload = () => {
      const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { realtime: { params: { eventsPerSecond: 20 } } });
      const channel = sb.channel("awantura:" + code, { config: { broadcast: { self: false }, presence: { key: "tv-" + Math.random().toString(36).slice(2) } } });
      channel
        .on("broadcast", { event: "state" }, ({ payload }) => onSnapshot(payload))
        .subscribe((status) => {
          if (status === "SUBSCRIBED") { setStatus(state ? "live" : "wait"); channel.track({ at: Date.now(), tv: true }); }
          else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") setStatus("off");
        });
    };
    tag.onerror = () => setStatus("off");
    document.head.appendChild(tag);
  }

  function tellParent(msg) {
    if (window.parent === window) return;
    try { window.parent.postMessage({ awantura: msg }, "*"); } catch (_) {}
  }

  let leftUntil = 0, leftText = "";
  function onSnapshot(p) {
    if (!p || p.code !== code || typeof p.hostId !== "string") return;
    if (!hostId) { hostId = p.hostId; sessionStorage.setItem(hostKey, hostId); }
    if (p.hostId !== hostId) return;
    if (p.sentAt && p.sentAt < lastSentAt) return;
    lastSentAt = p.sentAt || lastSentAt;
    lastMsgAt = Date.now();
    if (p.sentAt) skew = Date.now() - p.sentAt;  // host clock → this screen (lag included): for the wheel
    window.__awanturaTV.last = p;
    // Embedded (Mac sandbox): tell the parent page what is on, e.g. to add the Masters phone in the final.
    tellParent({ phase: p.phase, stage: p.stage, teams: p.teams.map((t) => t.id), code: p.code });
    const q = p.question;
    if (q) {
      const running = q.timerRunning && !q.hintOffer;
      if (!clock || clock.left !== q.timeLeft || clock.running !== running) clock = { left: q.timeLeft, running, at: Date.now() };
    } else clock = null;
    if (state && state.phase === "strike" && p.phase === "question" && p.question) {
      leftUntil = Date.now() + 1500; leftText = "ZOSTAŁA: " + p.question.category;
      setTimeout(() => render(), 1550);
    }
    const same = state && JSON.stringify({ ...state, sentAt: 0, seq: 0 }) === JSON.stringify({ ...p, sentAt: 0, seq: 0 });
    state = p;
    setStatus("live");
    if (!same) render();
  }

  function setStatus(kind) {
    statusKind = kind;
    const text = kind === "live" ? "NA ŻYWO" : kind === "stale" ? "BRAK SYGNAŁU OD PROWADZĄCEGO"
      : kind === "wait" ? "CZEKAM NA GRĘ" : kind === "off" ? "BRAK POŁĄCZENIA · ŁĄCZĘ…" : "ŁĄCZĘ…";
    const warn = $("conn");
    warn.hidden = !(kind === "stale" || kind === "off") || !state;
    warn.textContent = text;
    const info = $("tvInfo"); if (info) info.textContent = text + " · KOD " + code;
    if (debug) { const d = $("dbg"); d.hidden = false; d.textContent = text; }
  }
  setInterval(() => { if (state && statusKind !== "off" && Date.now() - lastMsgAt > 8000) setStatus("stale"); }, 2000);

  // ---- animated LED numbers (CountingNumber), same as app.js ------------------
  // Money moves in steps of 100 (100 ms per step up to 2000, 50 ms up to 5000,
  // faster above); every digit sits in its own fixed cell (all LED digits share
  // one width) and changed digits roll up like iOS numeric text.
  const tweens = new Map(), lastNums = {};
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
      cell.innerHTML = `<i>${cur}</i><i>${c}</i>`;
      cell.classList.remove("roll"); void cell.offsetWidth; cell.classList.add("roll");
      cell.onanimationend = () => { cell.classList.remove("roll"); cell.innerHTML = `<i>${c}</i>`; };
    });
  }
  function num(el, value) {
    const from = Number(el.dataset.v ?? value);
    el.dataset.v = value;
    clearTimeout(tweens.get(el));
    if (from === value) { paint(el, String(value), false); return; }
    const dir = Math.sign(value - from), d = Math.abs(value - from);
    const ms = el.dataset.dur ? Math.max(10, Number(el.dataset.dur) / Math.max(1, Math.ceil(d / 100))) : stepMs(d);
    let cur = from;
    paint(el, String(cur), false);
    // data-jump: no counting, the value just changes after the delay (accounts after WYGRANA)
    if (el.dataset.jump) { tweens.set(el, setTimeout(() => paint(el, String(value), false), Number(el.dataset.delay || 0))); return; }
    const tick = () => {
      cur = dir > 0 ? Math.min(value, cur + 100) : Math.max(value, cur - 100);
      if (Math.abs(value - cur) < 100) cur = value;
      paint(el, String(cur), ms >= 40);
      if (cur !== value) tweens.set(el, setTimeout(tick, ms));
    };
    tweens.set(el, setTimeout(tick, Number(el.dataset.delay || 0) + ms));
  }
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

  // ---- fit text (same rules as app.js) -----------------------------------------
  // One bar, one layout: label next to value; if a cell does not fit, the whole
  // bar puts labels above values (StudioView's BarRow), then `fit` shrinks.
  function fitBars(root) {
    root.querySelectorAll(".bar").forEach((bar) => {
      const cells = [...bar.querySelectorAll(":scope > .cell")];
      bar.classList.remove("stack");
      cells.forEach((c) => c.querySelectorAll("[data-fit]").forEach((v) => { v.style.fontSize = ""; }));
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
      const H = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      if (W <= 0 || H <= 0) return;
      const shown = el.innerHTML;
      if (el.dataset.probe && el.dataset.probe.length > el.textContent.length) el.textContent = el.dataset.probe;
      el.style.fontSize = "";
      let lo = Number(el.dataset.min || 10), hi = parseFloat(getComputedStyle(el).fontSize);
      const fits = (s) => { el.style.fontSize = s + "px"; return el.offsetWidth <= W + 0.5 && el.scrollWidth <= el.offsetWidth + 1 && el.offsetHeight <= H + 0.5; };
      if (fits(hi)) { el.style.fontSize = ""; el.innerHTML = shown; return; }
      if (!fits(lo)) { el.style.fontSize = lo + "px"; el.innerHTML = shown; return; }
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (fits(mid)) lo = mid; else hi = mid; }
      el.style.fontSize = lo + "px";
      el.innerHTML = shown;
    });
    // data-fit-group: siblings (the auction offers) share the smallest size.
    const groups = {};
    root.querySelectorAll("[data-fit-group]").forEach((el) => (groups[el.dataset.fitGroup] ||= []).push(el));
    Object.values(groups).forEach((els) => {
      const sizes = els.map((el) => parseFloat(el.style.fontSize || getComputedStyle(el).fontSize));
      const min = Math.min(...sizes);
      if (isFinite(min)) els.forEach((el) => { el.style.fontSize = min + "px"; });
    });
  }
  let fitQueued = 0;
  addEventListener("resize", () => { cancelAnimationFrame(fitQueued); fitQueued = requestAnimationFrame(() => fitAll(document)); });
  if (document.fonts) document.fonts.ready.then(() => fitAll(document));

  // ---- helpers ---------------------------------------------------------------
  const tc = (id) => "t-" + (id || "masters");   // no team (1 NA 1) = black like Mistrzowie
  const nameOf = (s, id) => (s.teams.find((t) => t.id === id) || {}).name || (id === "masters" ? "MISTRZOWIE" : "");
  // ONE bar cell, same markup as app.js cell(): label next to an LED value.
  //   cls: good | bad | hl (reversed) | team t-<id> ; grow: takes the rest of the bar
  function cell(c) {
    const v = c.n ? `<span class="v led" data-num="${c.n}" data-target="${c.v}" ${c.vid ? `id="${c.vid}"` : ""}>${c.v}</span>`
      : c.v === "" || c.v == null ? (c.vid ? `<span class="v led" id="${c.vid}"></span>` : "")
      : `<span class="vb"><span class="v led" data-fit="css" data-min="9" ${c.vid ? `id="${c.vid}"` : ""}>${c.v}</span></span>`;
    const k = c.k != null ? `<span class="k" ${c.kid ? `id="${c.kid}"` : ""}>${c.k}</span>` : "";
    return `<div class="cell ${c.cls || ""} ${c.grow ? "grow" : ""}" ${c.attrs || ""}>${k}${v}</div>`;
  }
  // Like StudioView's BarRow: with no `grow` cell, all cells share the width.
  const barOf = (cells, cls = "") => {
    const anyGrow = cells.some((c) => c.grow);
    return `<div class="bar ${cls}">${cells.map((c) => cell(anyGrow ? c : { ...c, grow: true })).join("")}</div>`;
  };
  const roundCell = (s) =>
    s.phase === "gameEnd" ? { v: "KONIEC GRY" } : s.phase === "stageEnd" ? { v: "KONIEC ETAPU 1" }
    : s.phase === "setup" ? { v: "START" }
    : { k: s.stage === "final" ? "FINAŁ" : "RUNDA", v: s.bonus ? (s.stage === "final" ? "BONUS" : "BONUSOWA") : `${s.questionNumber}/${s.rounds}` };

  // ---- render (StudioView 1:1) ---------------------------------------------------
  function render() {
    const stage = $("stage"), s = state;
    if (!s) {
      stage.dataset.spin = ""; stage.dataset.sig = "";
      stage.innerHTML = `<div class="panel"><div class="msg dim"><span class="led" data-fit="css" data-min="12">AWANTURA O KASĘ</span></div>
        <div class="fine" id="tvInfo">ŁĄCZĘ… · KOD ${esc(code)}</div></div>`;
      fitAll(stage); return;
    }
    if (s.boxOpening) {
      // A black box opening at the end: full screen, drum roll (v13).
      stage.dataset.spin = ""; stage.dataset.sig = "";
      stopWheel();
      const b = s.boxOpening, name = esc(nameOf(s, b.owner));
      stage.innerHTML = barOf([{ k: "CZARNA SKRZYNKA", v: name, cls: `team ${tc(b.owner)}`, grow: true }], "top") +
        `<div class="panel"><div class="boxopen">${b.prize
          ? `<div class="cap">W ŚRODKU JEST</div><div class="val"><span class="led" data-fit="css" data-min="30">${esc(b.prize)}</span></div><div class="cap dim">NAGRODA DODATKOWA · NIE ZMIENIA WYNIKU GRY</div>`
          : `<div class="val"><span class="led drum">…</span></div>`}</div></div>`;
      fitAll(stage);
      playDrum(b);
      return;
    }
    if (Date.now() < leftUntil && s.phase === "question") {
      stage.dataset.spin = ""; stage.dataset.sig = "";
      stage.innerHTML = top(s) + `<div class="panel">${message(esc(leftText))}</div>`;
      fitAll(stage); tickClock();
      return;
    }
    if (s.spin) {
      // The wheel turning on the host's phone: full screen here too. Same spin
      // = keep the running animation.
      // v15b: same wheel (hand hold, catch, release) = keep it, only turn it.
      const key = String(s.spin.startedAt), sig = s.spin.fields.map((f) => f.title).join("|");
      if (stage.dataset.spin !== key) {
        if (stage.dataset.sig !== sig) {
          stage.dataset.sig = sig;
          stage.innerHTML = `<div class="bar top">${cell(roundCell(s))}<div class="cell grow"><span class="v led" id="wheelTicker"></span></div></div>
          <div class="wheel-area">${wheelSVG(s.spin)}</div>`;
        }
        stage.dataset.spin = key;
        startWheel(s.spin);
      }
      return;
    }
    stage.dataset.spin = ""; stage.dataset.sig = "";
    stopWheel();
    stage.innerHTML = top(s) + effects(s) + tiles(s) + `<div class="panel">${panel(s)}</div>`;
    tickClock();
    fitAll(stage);
    settleNums(stage);
  }

  // Top bar: RUNDA · category · PULA — during a question DO WYGRANIA on the
  // answering team's colour + the clock apart.
  function top(s) {
    let cat = s.phase === "wheel" ? "" : s.fieldTitle ? esc(s.fieldTitle) : "";
    if (s.question && s.question.duel) cat = `1 NA 1 · ${esc(s.question.category)}`;  // the category too (v13)
    const cells = [roundCell(s), { v: cat, grow: true }];
    if (s.phase === "question" && s.question) {
      const q = s.question;
      cells.push({ k: "DO WYGRANIA", v: s.pot + " ZŁ", cls: `team ${tc(q.duel ? null : q.team)}` });
      cells.push({ k: "", kid: "clockLbl", v: "", vid: "clockNum", attrs: 'id="clock"' });
    } else cells.push({ k: s.bankAuction && s.pot > 0 ? "PULA · NIE GRA TERAZ" : "PULA", v: s.pot, n: "pot" });
    return barOf(cells, "top");
  }

  // AKCJE PROWADZĄCEGO this round (v13): KARA red, PREMIA green; a bought hint.
  function effects(s) {
    let out = "";
    if (s.question && s.question.hintPaid) out += barOf([{ k: "PODPOWIEDŹ KUPIONA", v: `−${s.question.hintPaid} ZŁ`, cls: "hl" }], "fx");
    (s.actions || []).forEach((a) => { out += barOf([{ k: a.team ? `${esc(a.label)} · ${esc(nameOf(s, a.team))}` : esc(a.label),
      v: `${a.kind === "penalty" ? "−" : "+"}${a.amount} ZŁ`, cls: a.kind === "penalty" ? "bad" : "good" }], "fx"); });
    return out;
  }

  // Playing teams: the account (offer already taken off, like the players'
  // page) on the colour, no names. Bankrupt = darkened colour + BANKRUT.
  // After DOBRZE the winner's account jumps by the pot once WYGRANA has run.
  function tiles(s) {
    const playing = s.teams.filter((t) => t.playing);
    if (!playing.length) return "";   // before GRAJ: no teams yet
    const r = s.result, wonId = s.phase === "roundResult" && r && r.kind === "correct" ? r.team : null;
    return `<div class="tiles">${playing.map((t) => t.bankrupt
      ? `<div class="tile out ${tc(t.id)}"><span class="led">BANKRUT</span></div>`
      : t.forPot   // after VA BANQUE: 0 on the account, playing for the whole pot (v13)
      ? `<div class="tile forpot ${tc(t.id)}"><span class="led">GRA O PULĘ</span></div>`
      : `<div class="tile ${tc(t.id)}"><span class="led" data-num="t-${t.id}" data-target="${t.balance}"
           ${t.id === wonId ? `data-from="${t.balance - r.amount}" data-delay="2200" data-jump="1"` : ""}>${t.balance}</span></div>`).join("")}</div>`;
  }

  function panel(s) {
    switch (s.phase) {
      case "auction": return auction(s);
      case "strike": return s.strike ? strike(s) : message("1 NA 1");
      case "question": return s.question ? question(s) : message("AWANTURA O KASĘ");
      case "roundResult": return s.result ? result(s) : message(esc(s.fieldTitle || "AWANTURA O KASĘ"));
      case "stageEnd": case "gameEnd": return end(s);
      case "wheel": return s.fieldTitle ? message(esc(s.fieldTitle)) : message("ZARAZ LOSUJEMY", true);
      default: return message("AWANTURA O KASĘ");
    }
  }

  const message = (text, dim = false) =>
    `<div class="msg ${dim ? "dim" : ""}"><span class="led" data-fit="css" data-min="12">${text}</span></div>`;

  // Auction (TV look, v11): the leading offer lit in full colour, the others
  // dimmed (dark team colour, light digits), out / BLOKADA darker with a word;
  // VA BANQUE blinks every 200 ms. Nothing else moves on its own (v14).
  let prevBids = {};
  function auction(s) {
    const teams = s.teams.filter((t) => t.playing);
    const pulsed = new Set(teams.filter((t) => t.leading && prevBids[t.id] != null && t.bid > prevBids[t.id]).map((t) => t.id));
    prevBids = Object.fromEntries(teams.map((t) => [t.id, t.bid]));
    const probe = "8".repeat(Math.max(4, String(Math.max(...teams.map((x) => x.bid))).length));
    const cols = teams.map((t) => {
      const word = !t.inAuction ? (t.bankrupt ? "BANKRUT" : "NIE LICYTUJE") : t.blocked ? "BLOKADA" : t.vaBanque ? "VA BANQUE" : "";
      const cls = !t.inAuction || t.blocked ? "out" : t.leading || t.vaBanque ? "lead" : "";
      const bid = t.inAuction ? `<span class="led" data-num="bid-${t.id}" data-target="${t.bid}" data-fit="css" data-min="20" data-fit-group="bids" data-probe="${probe}">${t.bid}</span>` : "";
      return `<div class="offer ${tc(t.id)} ${cls} ${t.vaBanque ? "vb" : ""} ${pulsed.has(t.id) && !t.vaBanque ? "pulse" : ""}"
          aria-label="${esc(t.name)}: ${t.inAuction ? `oferta ${t.bid} zł` : word.toLowerCase()}${t.leading ? ", prowadzi" : ""}">
          <div class="ov">${bid}</div>${word ? `<div class="st">${word}</div>` : ""}</div>`;
    }).join("");
    return `<div class="cols">${cols}</div>`;
  }

  // 1 NA 1 with crossing out: whose turn on their colour, the list (2 per row).
  function strike(s) {
    const st = s.strike;
    const items = st.options.map((o) => `<div class="sk ${st.struck.includes(o) ? "out" : ""}"><span class="led">${esc(o)}</span></div>`).join("");
    return barOf([{ k: "1 NA 1 · SKREŚLAJĄ", v: esc(nameOf(s, st.turn)), cls: `team ${tc(st.turn)}`, grow: true }], "sub") + `<div class="tvstrike">${items}</div>`;
  }

  // Question card in the answering team's colour; haggling = one reversed bar above it.
  function question(s) {
    const q = s.question;
    const id = q.duel ? null : q.team;
    const answers = q.answers ? `<div class="answers">${q.answers.map((a, i) =>
      `<div class="a"><span class="chip led">${"ABCD"[i]}</span><span class="tx">${esc(a)}</span></div>`).join("")}</div>` : "";
    return `${q.hintOffer ? barOf([{ v: `PODPOWIEDŹ ZA ${q.hintOffer} ZŁ?`, cls: "hl" }], "sub haggle") : ""}
      <div class="qcard ${tc(id)}">
        ${q.duel ? `<div class="who">1 NA 1 · KTO PIERWSZY, TEN ODPOWIADA</div>` : ""}
        <div class="qtext"><span data-fit="css" data-min="12">${esc(q.text)}</span></div>
        ${answers}
      </div>`;
  }

  // WYGRANA: counts up to the pot (~1.5 s) or falls from it to zero (~3 s) on
  // the answering team's colour; verdict + right answer in a bar underneath.
  function result(s) {
    const r = s.result, name = esc(nameOf(s, r.team));
    let caption, cells;
    if (r.kind === "correct") { caption = "WYGRYWAJĄ PULĘ"; cells = [{ k: `WYNIK · ${name}`, v: "DOBRZE", cls: "good" }]; }
    else if (r.kind === "wrong") {
      caption = r.amount > 0 ? "PULA PRZECHODZI DALEJ" : "PULA BYŁA PUSTA";
      cells = [{ k: r.team ? `WYNIK · ${name}` : "NIKT NIE ODPOWIEDZIAŁ", v: "ŹLE", cls: "bad" }];
    } else if (r.kind === "hint") { caption = "ZAPŁACILI"; cells = [{ k: "PODPOWIEDŹ NA PÓŹNIEJ", v: name }]; }
    else { caption = "ZAPŁACILI"; cells = [{ k: "CZARNA SKRZYNKA", v: name, cls: "hl" }]; }
    if (r.correctAnswer) cells.push({ k: "POPRAWNA ODPOWIEDŹ", v: esc(r.correctAnswer), grow: true });
    const won = r.kind === "correct", counter = won || r.kind === "wrong";
    const key = ["res", s.stage, s.questionNumber, r.kind, r.team].join("-");
    const value = counter
      ? `<span class="led" data-num="${key}" data-target="${won ? r.amount : 0}" data-from="${won ? 0 : r.amount}" data-dur="${won ? 1500 : 3000}" data-delay="${won ? 200 : 600}">${won ? 0 : r.amount}</span>`
      : `<span class="led">${r.amount}</span>`;
    // "WYGRANA" only for DOBRZE (v13).
    return bigPanel(won ? "WYGRANA · " + caption : r.kind === "wrong" ? "ŹLE · " + caption : caption, value, r.team) + barOf(cells, "foot");
  }

  // Winner's colour with the outcome in big LED letters; black boxes in a bar underneath.
  function end(s) {
    const headline = s.phase === "stageEnd" ? "DO FINAŁU!" : s.winner === "masters" ? "OBRONILI TYTUŁ"
      : s.stage === "final" ? "NOWI MISTRZOWIE" : "WYGRYWAJĄ";
    const cells = s.boxes.map((b) => ({ k: `SKRZYNKA · ${esc(nameOf(s, b.owner))}`, v: b.open ? esc(b.prize || "") : "ZAMKNIĘTA", cls: "hl" }));
    const tie = s.tieBreak === "wins" ? "REMIS · WIĘCEJ DOBRYCH ODPOWIEDZI" : s.tieBreak === "draw" ? "REMIS · ROZSTRZYGNĘŁO LOSOWANIE" : null;
    return bigPanel(tie, `<span class="led" data-fit="css" data-min="20">${headline}</span>`, s.winner, "head") + (cells.length ? barOf(cells, "foot") : "");
  }

  const bigPanel = (caption, value, team, cls = "") =>
    `<div class="bigp ${tc(team)} ${cls}">${caption ? `<div class="cap">${caption}</div>` : ""}<div class="val">${value}</div></div>`;

  // Local countdown (the host's phone is the truth; snapshots re-sync it).
  function tickClock() {
    const c = $("clock");
    if (!c || !state || !state.question || !clock) return;
    const q = state.question;
    const left = clock.running ? Math.max(0, clock.left - Math.floor((Date.now() - clock.at) / 1000)) : clock.left;
    const t = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    const n = $("clockNum");
    if (n && n.textContent !== t) n.textContent = t;
    $("clockLbl").textContent = q.hintOffer ? "ZEGAR STOI" : q.waiting ? "CZEKA" : clock.running && left > 0 ? "CZAS" : left === 0 ? "KONIEC CZASU" : "PAUZA";
    c.className = "cell" + (left === 0 ? " bad zero" : left <= 10 && !q.hintOffer ? " bad" : "");
  }
  setInterval(tickClock, 200);

  // Drum roll when a box opens (best effort: a TV browser may need one click first).
  let drum = null, drumFor = null;
  function playDrum(b) {
    if (b.prize || drumFor === b.startedAt) return;
    drumFor = b.startedAt;
    try { drum = drum || new Audio("drumroll.mp3"); drum.currentTime = 0; drum.play().catch(() => {}); } catch (_) {}
  }

  // ---- the wheel (live from the host), same as app.js ------------------------
  // The spin comes as data (fields, disc angle under the pointer from → to,
  // start time, duration): the TV turns its own SVG wheel with the same
  // ease-out-quart curve. Half wheel anchored at the bottom, pointer on top
  // (StudioView's WheelLayout.bottom); the field under the pointer runs through the bar.
  let wheelRAF = 0;
  const quart = (u) => 1 - Math.pow(1 - u, 4);
  // v15: a hand spin slows down with constant friction (ease-out quad).
  const quad = (u) => 1 - (1 - u) * (1 - u);
  const TEAM_HEX = { blue: "#0a84ff", green: "#30d158", yellow: "#ffd60a" };
  function wedgeStyle(f, catIndex) {
    if (f.kind === "category") { const c = ["blue", "green", "yellow"][catIndex % 3]; return { fill: TEAM_HEX[c], ink: "#000" }; }
    if (f.kind === "hint") return { fill: "#fff", ink: "#000" };
    if (f.kind === "blackBox") return { fill: "#050505", ink: "#fff", box: true };
    return { fill: "#000", ink: "#fff" };  // 1 NA 1 (Masters' black)
  }
  function wheelSVG(sp) {
    const n = sp.fields.length, seg = 360 / n, rim = 0.93;
    const pt = (deg, r) => { const a = (deg - 90) * Math.PI / 180; return [Math.cos(a) * r, Math.sin(a) * r]; };
    let cat = 0, wedges = "", labels = "", bulbs = "";
    sp.fields.forEach((f, i) => {
      const st = wedgeStyle(f, cat); if (f.kind === "category") cat++;
      const [x0, y0] = pt(i * seg, rim), [x1, y1] = pt((i + 1) * seg, rim);
      wedges += `<path d="M0 0 L${x0} ${y0} A${rim} ${rim} 0 0 1 ${x1} ${y1} Z" fill="${st.fill}" stroke="#1c1c1e" stroke-width=".006" data-i="${i}"/>`;
      if (st.box) wedges += `<path d="M0 0 L${x0} ${y0} A${rim} ${rim} 0 0 1 ${x1} ${y1} Z" fill="none" stroke="#fff" stroke-width=".006" transform="scale(.97)"/>`;
      const mid = i * seg + seg / 2;
      const size = Math.min(0.075, 0.62 / Math.max(6, f.title.length) * 1.25);
      labels += `<text transform="rotate(${mid - 90}) translate(.59 0)" fill="${st.ink}" font-size="${size}" text-anchor="middle" dominant-baseline="central">${esc(f.title)}</text>`;
    });
    for (let k = 0; k < n * 2; k++) {
      const [x, y] = pt(k * seg / 2, 0.965);
      bulbs += `<circle cx="${x}" cy="${y}" r=".014" fill="${k % 2 ? "#8e8e93" : "#f2f2f7"}"/>`;
    }
    return `<svg class="wheel-svg" viewBox="-1.08 -1.14 2.16 1.22" preserveAspectRatio="xMidYMax meet">
      <g id="disc">
        <circle r="1" fill="#1c1c1e" stroke="#636366" stroke-width=".004"/>
        ${wedges}<g class="wl">${labels}</g>${bulbs}
        <path id="winWedge" d="" fill="none" stroke="#fff" stroke-width=".012" filter="url(#glow)"/>
      </g>
      <circle r=".2" fill="#000"/>
      <path d="M-.065 -1.13 L.065 -1.13 L0 -.95 Z" fill="#fff" filter="url(#glow)"/>
      <defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation=".012" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
    </svg>`;
  }
  function startWheel(sp) {
    stopWheel();
    const disc = document.getElementById("disc"), seg = 360 / sp.fields.length;
    const t0 = sp.startedAt + skew, dur = sp.duration * 1000;
    const hold = sp.curve === "hold";  // v15b: the host holds the wheel (≈10 updates/s)
    if (disc) disc.style.transition = hold ? "transform 120ms linear" : "none";
    const win0 = $("winWedge"); if (win0) win0.setAttribute("d", "");
    let lastTitle = "";
    const frame = () => {
      const u = Math.max(0, Math.min(1, (Date.now() - t0) / dur));
      const off = sp.from + (sp.to - sp.from) * (sp.curve === "quad" ? quad(u) : quart(u));
      if (disc) disc.style.transform = `rotate(${-off}deg)`;
      const idx = Math.floor((((off % 360) + 360) % 360) / seg) % sp.fields.length;
      const title = u >= 1 ? sp.fields[sp.landed].title : sp.fields[idx].title;
      if (title !== lastTitle) { lastTitle = title; const t = $("wheelTicker"); if (t) t.textContent = title; }
      if (u < 1) wheelRAF = requestAnimationFrame(frame);
      else {
        const w = document.querySelector(`#disc path[data-i="${sp.landed}"]`), win = $("winWedge");
        if (w && win && !hold) win.setAttribute("d", w.getAttribute("d"));
      }
    };
    wheelRAF = requestAnimationFrame(frame);
  }
  function stopWheel() { cancelAnimationFrame(wheelRAF); }

  // ?debug=1: feed a hand-made snapshot (screenshots / QA of rare screens).
  if (debug) window.__awanturaTV.inject = (p) => { if (!hostId) hostId = "debug"; lastSentAt = 0; onSnapshot({ ...p, code, hostId, sentAt: Date.now() }); };

  // Keep a TV browser / laptop awake.
  let lock = null;
  const keepAwake = async () => { try { if ("wakeLock" in navigator && (!lock || lock.released)) lock = await navigator.wakeLock.request("screen"); } catch (_) {} };
  keepAwake();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") keepAwake(); });
  document.addEventListener("click", keepAwake, { passive: true });

  render();
  setStatus("connecting");
})();
