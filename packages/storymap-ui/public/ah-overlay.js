/* AgileHarness feedback overlay — Fase 1 (framework-agnostic, zero-dependency).
 *
 * Drop-in snippet the product app loads (first-party, no extension, no CSP fight). It captures
 * element anchors (grep-friendly selector + text + rect + route) and a note per pin, then POSTs
 * an AnnotationBatch to the broker (/api/feedback/intake). It NEVER holds a credential — the
 * broker (running inside the authenticated board) is what writes.
 *
 * Config (any of):
 *   window.__AH_FEEDBACK_CONFIG__ = { endpoint, destinationsEndpoint, link:{ kind, board, cardId, sessionId },
 *     producer, icon, label, cardUrlTemplate,
 *     destinations:{ <kind>:{ label, verb, hint } },   // per mode copy — HOST POLICY, not core
 *     theme:{ accent, accentSoft, surface, surfaceHover, inset, line, fg, fgMuted, fgSubtle, danger, font, mono, radius } }
 *   or query params ?ah-board=<board>&ah-card=<id>&ah-session=<tmux>
 * `destinationsEndpoint` (optional) turns on the send-step PICKER: a segmented [none|card|session]
 * control whose card/session lists load from that endpoint (same-origin). Omit it → the overlay shows
 * a plain destination chip and routes by the context-seeded mode only (agnostic default).
 * Theme values may be CSS-var references (e.g. "rgb(var(--accent))") so the overlay tracks the host
 * app's palette + dark mode; omit for neutral light defaults. Core stays framework-agnostic: it does
 * NOT know what a "card"/"session" MEANS — the destination copy (label/verb/hint per link.kind), the
 * button glyph (`icon`, trusted host SVG markup) and the card link (`cardUrlTemplate`, with "{board}"/
 * "{id}" placeholders) are all injected by the host; a standalone consumer gets neutral defaults.
 * Routing itself stays link.kind-only — the picker never adds a second routing signal to the batch.
 */
(function () {
  "use strict";
  if (window.__AH_OVERLAY_MOUNTED__) return;
  window.__AH_OVERLAY_MOUNTED__ = true;

  var qs = new URLSearchParams(location.search);
  var cfg = window.__AH_FEEDBACK_CONFIG__ || {};
  var endpoint = cfg.endpoint || "/api/feedback/intake";
  var link = Object.assign({}, cfg.link); // carries board (+ any host pre-selected card/session)
  if (!link.board && qs.get("ah-board")) link.board = qs.get("ah-board");
  if (qs.get("ah-card")) { link.kind = "card"; link.cardId = qs.get("ah-card"); }
  else if (qs.get("ah-session")) { link.kind = "session"; link.sessionId = qs.get("ah-session"); }
  var producer = cfg.producer || "agileharness-overlay";
  var cardUrlTemplate = typeof cfg.cardUrlTemplate === "string" ? cfg.cardUrlTemplate : "";
  var destinationsEndpoint = typeof cfg.destinationsEndpoint === "string" ? cfg.destinationsEndpoint : "";
  // IMAGE capture — HOST POLICY, like every other capability here. `shotEndpoint` receives the PNG;
  // omit it and the overlay degrades cleanly to annotation-only (no image anywhere), which is what a
  // consumer without an image store, or a cross-origin embed, should get.
  //
  // TWO SOURCES, both REAL PIXELS. A page cannot photograph itself — the only first-party pixel API is
  // getDisplayMedia — so:
  //   1. DISPLAY CAPTURE — one permission dialog per session (preferCurrentTab makes it one click),
  //      then the stream is KEPT ALIVE and every drawn region is a ~16ms frame grab. What you see is
  //      what is sent: canvas, video, iframes, real fonts, real stacking.
  //   2. PASTE — Ctrl/Cmd+V of a system screenshot, on ANY annotation (element or region). No API, no
  //      dialog; the OS's own crop tool did the framing. Also the escape hatch when capture is denied.
  // A DOM-reconstruction rasterizer (snapdom) used to be the mechanism here and was REMOVED by operator
  // decision: it was slow (a second full layout+paint of the subtree) and structurally unfaithful
  // (cross-origin images, canvas/video, fonts, stacking). Don't reintroduce it — if capture is denied,
  // the annotation simply travels without a picture, which it is designed to do.
  var shotEndpoint = typeof cfg.shotEndpoint === "string" ? cfg.shotEndpoint : "";
  var displayCaptureEnabled = cfg.displayCapture !== false;
  var MAX_SHOT_EDGE = 1600;              // cap the longest edge of the produced image (payload sanity)
  var MAX_SHOT_BYTES = 2.5 * 1024 * 1024; // above this we re-encode as JPEG (the store's cap is 3MB)

  // --- EMBED mode (F5): the overlay running on the PRODUCT's own site, cross-origin to the board. A
  //     board-issued nonce (config or ?ah-nonce=) is what authorises it. The server independently
  //     enforces everything below — this is the UI telling the truth about what the server will do:
  //       • TRIAGE-ONLY: the server collapses an embed's link to "none", so offering a card/session
  //         picker would be a lie (and the catalog is same-origin-only — the fetch would 403 anyway).
  //       • NO IMAGE: the shot store is same-origin-only, so a cross-origin page has nowhere to upload
  //         to (`shotEndpoint` is cleared by the host in that mode). The region's DOM anchor — selector,
  //         covered elements, rect, route — still travels; only the picture doesn't.
  var nonce = typeof cfg.nonce === "string" && cfg.nonce ? cfg.nonce : (qs.get("ah-nonce") || "");
  var embedMode = !!nonce;
  if (embedMode) {
    link.kind = "none"; delete link.cardId; delete link.sessionId;
    destinationsEndpoint = "";
  }
  var canCaptureImage = !embedMode && !!shotEndpoint;

  // The DESTINATION is chosen at SEND time (not mount). `mode` seeds from context — a host-pinned
  // card/session (?ah-card/?ah-session or cfg.link) pre-selects that mode; a cold start defaults to
  // "none" (never a surprise route). The card/session pickers load lazily from destinationsEndpoint;
  // without it the overlay degrades to a plain destination chip (agnostic consumer). resolveLink()
  // turns (mode, selection) into the batch link — mirroring the server's deriveLink; kind-only routing.
  var mode = link.kind === "card" ? "card" : link.kind === "session" ? "session" : "none";
  var sel = { card: link.cardId || null, session: link.sessionId || null };
  var catalog = null;         // { sessionEnabled, options:[{kind,id,label,sublabel?,busy?}] } once fetched
  var catalogState = "idle";  // idle | loading | loaded | error
  var cardFilter = "";
  var minimized = false;      // collapse the capture panel to a chip, keeping the pins
  var cancelConfirm = false;  // cancel = discard all pins → asks for confirmation first
  var CARD_PREVIEW = 7;       // cards shown before typing; the rest surface via search

  // --- theming: map the config `theme` onto namespaced --ah-* CSS vars (with neutral light defaults).
  //     The host app can pass CSS-var references (e.g. "rgb(var(--accent))") so the overlay auto-matches
  //     the app palette AND dark mode; a standalone consumer just gets the defaults. Core stays agnostic. ---
  var AH_THEME_DEFAULTS = {
    accent: "#4f46e5", "accent-soft": "rgba(79,70,229,.26)", surface: "#ffffff",
    "surface-hover": "#f4f4f5", inset: "#f4f4f5", line: "#e4e4e7", fg: "#1f2430",
    "fg-muted": "#6b7280", "fg-subtle": "#9ca3af", danger: "#c0392b", radius: "10px",
    font: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
    mono: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
  };
  var AH_THEME_KEYS = {
    accent: "accent", accentSoft: "accent-soft", surface: "surface", surfaceHover: "surface-hover",
    inset: "inset", line: "line", fg: "fg", fgMuted: "fg-muted", fgSubtle: "fg-subtle",
    danger: "danger", radius: "radius", font: "font", mono: "mono",
  };
  (function () {
    var theme = cfg.theme || {};
    var root = document.documentElement;
    Object.keys(AH_THEME_DEFAULTS).forEach(function (k) { root.style.setProperty("--ah-" + k, AH_THEME_DEFAULTS[k]); });
    Object.keys(AH_THEME_KEYS).forEach(function (k) { if (theme[k] != null) root.style.setProperty("--ah-" + AH_THEME_KEYS[k], String(theme[k])); });
  })();

  // --- destination copy + button glyph: HOST POLICY with neutral core defaults. The core is
  //     semantics-blind — it never hardcodes "card"/"triagem"/a brand name; the host injects the
  //     words for each link.kind. This is the seam that lets the SAME overlay run on the board
  //     (card/session/triage) and, later, embedded cross-origin in a product app (triage-only). ---
  // The button glyph. AH_STOP and the DEFAULT icon below are TRUSTED literals (safe via innerHTML). A
  // HOST-injected cfg.icon is the one spot untrusted markup could reach an innerHTML sink, so we do NOT
  // trust it and we do NOT regex-gate it: a regex over HTML source can't model the tokenizer — e.g.
  // `<svg></svg><img/onerror=alert(1) src=x>` slips past a whitespace-anchored on*= check (the char
  // before "on" is "/") and its trailing sibling rides into the sink. Instead we PARSE cfg.icon as XML
  // (no script runs on parse), require a single <svg> root (no trailing siblings), reject
  // <script>/<foreignObject>, ANY on* handler attribute and ANY href/xlink:href, then IMPORT the vetted
  // node — never innerHTML. Invalid/unsafe/absent → the default glyph. A future less-trusted (e.g.
  // cross-origin embed) icon source therefore can't turn the button into an XSS vector.
  // NAMED glyphs the core ships (TRUSTED literals). A host picks one by name — `icon: "jido"` — or
  // passes its own SVG markup, which takes the untrusted path below. Named-by-string exists so the two
  // AgileHarness surfaces (the board's dogfood and a product app) don't each carry a COPY of the mark
  // and drift apart; a third-party consumer just omits `icon` and gets the neutral default.
  //   · default — a neutral marker+frame: annotate an interface, no branding.
  //   · jido    — the AgileHarness mascot (grid 100: antenna 44,16 · body 20,28,60,38 · feet · arms),
  //               eyes CUT OUT by a mask (so they read on any button colour, light or dark), holding a
  //               marker in the brand orange. Says "this is the tool, not the app you're looking at".
  var AH_ICONS = {
    default:
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h13v9H8l-5 4z"/><path d="m16 16 5-5"/><path d="m19 14 2 2-3 3-2-2z"/></svg>',
    // 17px, not 15: at 15 the marker dissolves. The extra 2px cost nothing in the pill and are what
    // make the tool readable at a glance.
    //
    // Two things this glyph does NOT do, both learned the hard way on the board's own mascot:
    //   · no `shape-rendering="crispEdges"`. It rounds every edge INDEPENDENTLY to the nearest device
    //     pixel, which is a no-op at integer scale and a deformation at fractional scale — and 100
    //     grid units drawn at 17px is 0.17px per unit, fractional on every screen there is. It was
    //     making same-size pieces render at different sizes (one eye wider than the other).
    //   · no <mask> for the eyes. A mask rasterises into its own buffer and hands back partial alpha
    //     on the edges, so at this size the eyes came out GREY instead of cut through. They are now
    //     reverse-wound subpaths inside a single `nonzero` path — a real hole in the geometry, one
    //     rasterisation, and the button colour shows through whatever it is.
    // Anatomy is the design board's, unit for unit (antenna 44,16 · body 20,28,60,38 · legs · arms ·
    // eyes 34/58,40,8,12) — the same numbers `src/lib/storymap/copilot/mascot.ts` carries at half
    // scale. This file stays framework-free on purpose (it ships to embeds), so the copy is real —
    // but it is NOT unguarded: `mascot-icons.test.ts` rebuilds this exact `d` from mascot.ts and
    // fails if the two ever disagree. Edit the art there, then paste the new path here.
    jido:
      '<svg width="17" height="17" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
      '<path fill="currentColor" fill-rule="nonzero" d="' +
      // silhouette, clockwise
      "M44 16H56V28H44ZM20 28H80V66H20ZM30 66H42V80H30ZM58 66H70V80H58ZM8 36H20V48H8ZM80 36H92V48H80Z" +
      // eyes, counter-clockwise → holes
      'M34 40V52H42V40ZM58 40V52H66V40Z"/>' +
      '<g fill="#FF4F00"><rect x="66" y="34" width="12" height="12"/><rect x="76" y="22" width="12" height="12"/><rect x="86" y="10" width="14" height="14"/></g>' +
      "</svg>",
  };
  var AH_ICON_DEFAULT = AH_ICONS.default;
  function safeIconNode(m) {
    if (typeof m !== "string" || m.indexOf("<svg") < 0) return null;
    var doc;
    try { doc = new DOMParser().parseFromString(m, "image/svg+xml"); } catch (e) { return null; }
    if (!doc || doc.getElementsByTagName("parsererror").length) return null;
    var root = doc.documentElement;
    if (!root || String(root.nodeName).toLowerCase() !== "svg") return null;
    var els = [root], kids = root.getElementsByTagName("*"), i, k;
    for (i = 0; i < kids.length; i++) els.push(kids[i]);
    for (i = 0; i < els.length; i++) {
      var el = els[i], tag = String(el.nodeName).toLowerCase();
      if (tag === "script" || tag === "foreignobject") return null;
      var attrs = el.attributes || [];
      for (k = 0; k < attrs.length; k++) {
        var name = String(attrs[k].name).toLowerCase();
        if (name.indexOf("on") === 0 || name === "href" || name === "xlink:href") return null;
      }
    }
    return root;
  }
  // A NAME resolves to a trusted literal; anything else is treated as untrusted markup and must
  // survive safeIconNode. (A host that names a glyph we don't ship falls back to the default.)
  var AH_NAMED_ICON =
    typeof cfg.icon === "string" && Object.prototype.hasOwnProperty.call(AH_ICONS, cfg.icon) ? AH_ICONS[cfg.icon] : "";
  var AH_ICON_NODE = AH_NAMED_ICON ? null : safeIconNode(cfg.icon); // parse-vetted host <svg>, or null
  var AH_STOP = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  // "Marcar ajuste" and not "Feedback": the old word read as a support channel for the APP being
  // looked at. Verb + object leaves no room for that reading, for any consumer.
  var AH_LABEL = typeof cfg.label === "string" && cfg.label ? cfg.label : "Marcar ajuste";
  var AH_DEST_DEFAULTS = {
    none: { label: "Novo item", verb: "Enviar feedback", hint: "" },
    card: { label: "Item vinculado", verb: "Enviar ao item", hint: "" },
    session: { label: "Sessão", verb: "Enviar à sessão", hint: "" },
  };
  function destInfo(m) {
    var k = m || mode;
    var base = AH_DEST_DEFAULTS[k] || AH_DEST_DEFAULTS.none;
    var over = (cfg.destinations && cfg.destinations[k]) || {};
    return { label: over.label || base.label, verb: over.verb || base.verb, hint: over.hint || base.hint };
  }
  // Mirrors the server's deriveLink (link.ts) — (mode, selection) → a link.kind-only link. Kept in
  // parity by hand (the static IIFE can't import the TS). A routed mode with no selection stays "none".
  function resolveLink() {
    var l = { kind: "none" };
    if (link.board) l.board = link.board;
    if (mode === "card" && sel.card) { l.kind = "card"; l.cardId = sel.card; }
    else if (mode === "session" && sel.session) { l.kind = "session"; l.sessionId = sel.session; }
    return l;
  }
  function catOptions(kind) {
    if (!catalog || !catalog.options) return [];
    return catalog.options.filter(function (o) { return o.kind === kind; });
  }
  function fetchCatalog() {
    if (!destinationsEndpoint || catalogState === "loading" || catalogState === "loaded") return;
    catalogState = "loading";
    fetch(destinationsEndpoint, { headers: { accept: "application/json" }, credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.ok) { catalog = j; catalogState = "loaded"; } else { catalogState = "error"; } render(); })
      .catch(function () { catalogState = "error"; render(); });
  }

  // A destination is a ROW — selector, name, and what it actually does — not a tab. A segmented control
  // reads as navigation ("I'm filtering what I see"), which is the wrong promise for the one choice that
  // decides where the batch lands; and it could only afford a hint for the ACTIVE option, so the other
  // two were bare jargon. Each row now carries its own host-supplied hint, side by side.
  function destRow(k) {
    var info = destInfo(k);
    var b = document.createElement("button");
    b.type = "button";
    b.className = "ah-dest-row" + (mode === k ? " on" : "");
    b.setAttribute("aria-pressed", mode === k ? "true" : "false");
    var radio = document.createElement("span"); radio.className = "ah-radio";
    var body = document.createElement("span"); body.className = "ah-dest-b";
    var l = document.createElement("span"); l.className = "ah-dest-l"; l.textContent = info.label;
    body.appendChild(l);
    if (info.hint) {
      var s = document.createElement("span"); s.className = "ah-dest-s"; s.textContent = info.hint;
      body.appendChild(s);
    }
    b.appendChild(radio); b.appendChild(body);
    b.onclick = function () { if (mode !== k) { mode = k; revealPicker = k !== "none"; render(); } };
    return b;
  }
  function msgRow(t) { var d = document.createElement("div"); d.className = "ah-msg"; d.textContent = t; return d; }
  function optRow(o, selected, onpick) {
    var d = document.createElement("div"); d.className = "ah-opt" + (selected ? " on" : "");
    var l = document.createElement("div"); l.className = "ah-opt-l"; l.textContent = o.label || o.id; d.appendChild(l);
    if (o.busy) { var bz = document.createElement("span"); bz.className = "ah-busy"; bz.textContent = "ativa"; d.appendChild(bz); }
    if (o.sublabel) { var s = document.createElement("div"); s.className = "ah-opt-s"; s.textContent = o.sublabel; d.appendChild(s); }
    d.onclick = onpick;
    return d;
  }
  // Set when the operator picks a destination that needs a SELECTION: the picker it opens is below the
  // fold of a 320px panel, so without this the click looks like it did nothing. Scrolls the PANEL (not
  // the page — the panel is fixed, and scrollIntoView would move the app behind it).
  var revealPicker = false;
  var pickerEl = null;

  function renderCardPicker(panel) {
    var wrap = document.createElement("div");
    pickerEl = wrap;
    var inp = document.createElement("input"); inp.className = "ah-search"; inp.type = "text";
    inp.placeholder = "Buscar card por título ou id…"; inp.value = cardFilter;
    wrap.appendChild(inp);
    var listEl = document.createElement("div"); listEl.className = "ah-list"; wrap.appendChild(listEl);
    panel.appendChild(wrap);
    function repaint() {
      listEl.textContent = "";
      if (catalogState === "loading") { listEl.appendChild(msgRow("Carregando…")); return; }
      if (catalogState === "error") { listEl.appendChild(msgRow("Não consegui listar. Use “Novo item”.")); return; }
      var q = cardFilter.trim().toLowerCase();
      var matched = catOptions("card").filter(function (o) {
        return !q || (o.label && o.label.toLowerCase().indexOf(q) >= 0) || o.id.toLowerCase().indexOf(q) >= 0;
      });
      // Only a few recents up front; the rest surface as you type (avoids a wall of cards).
      var items = matched.slice(0, q ? 40 : CARD_PREVIEW);
      if (!items.length) { listEl.appendChild(msgRow(q ? "Nenhum card casa a busca." : "Sem cards.")); return; }
      items.forEach(function (o) { listEl.appendChild(optRow(o, sel.card === o.id, function () { sel.card = o.id; render(); })); });
      if (!q && matched.length > items.length) {
        listEl.appendChild(msgRow("+" + (matched.length - items.length) + " — digite para buscar"));
      }
    }
    inp.oninput = function () { cardFilter = inp.value; repaint(); };
    repaint();
  }
  function renderSessionPicker(panel) {
    var listEl = document.createElement("div"); listEl.className = "ah-list";
    pickerEl = listEl;
    if (catalogState === "loading") listEl.appendChild(msgRow("Carregando sessões…"));
    else if (catalogState === "error") listEl.appendChild(msgRow("Não consegui listar sessões."));
    else {
      var items = catOptions("session");
      if (!items.length) listEl.appendChild(msgRow("Nenhuma sessão de agente ativa."));
      else items.forEach(function (o) { listEl.appendChild(optRow(o, sel.session === o.id, function () { sel.session = o.id; render(); })); });
    }
    panel.appendChild(listEl);
  }
  // SCREEN 2 — the destination, and nothing else. The annotations collapse into one summary line (they
  // were already reviewed on screen 1), so the only decision on screen is where this goes. Send is ONE
  // click for EVERY mode — the paste-into-a-live-session safeguard is server-side (the sink refuses
  // the master/orchestrator, sanitizes the payload and never presses Enter), so the client adds no
  // extra ceremony; the session caveat ("you press Enter") rides in the host's `session.hint`.
  function renderSend(panel) {
    // Back re-arms marking: "continuar marcando" has to actually resume the tool, not just show the list.
    var back = document.createElement("button"); back.type = "button"; back.className = "ah-back";
    back.textContent = "‹ Continuar marcando";
    back.onclick = function () { step = "collect"; setPicking(true); };
    panel.appendChild(back);

    var sum = document.createElement("div"); sum.className = "ah-summary";
    var st = document.createElement("span");
    st.textContent = pins.length + (pins.length === 1 ? " ajuste marcado" : " ajustes marcados");
    var rev = document.createElement("button"); rev.type = "button"; rev.className = "ah-revise";
    rev.textContent = "Revisar";
    rev.onclick = function () { step = "collect"; render(); };
    sum.appendChild(st); sum.appendChild(rev);
    panel.appendChild(sum);

    var info = destInfo();
    if (destinationsEndpoint) {
      var lab = document.createElement("div"); lab.className = "ah-label"; lab.textContent = "Enviar para";
      panel.appendChild(lab);
      var rows = document.createElement("div"); rows.className = "ah-dests";
      rows.appendChild(destRow("none"));
      rows.appendChild(destRow("card"));
      if (catalog && catalog.sessionEnabled) rows.appendChild(destRow("session"));
      panel.appendChild(rows);
      if (mode === "card") renderCardPicker(panel);
      else if (mode === "session") renderSessionPicker(panel);
    } else {
      // Agnostic consumer: no live discovery ⇒ exactly one destination, so it is a statement, not a choice.
      var chip = document.createElement("div"); chip.className = "ah-dest";
      var dl = document.createElement("div"); dl.className = "dl"; dl.textContent = "Destino: " + info.label;
      chip.appendChild(dl);
      if (info.hint) { var ch = document.createElement("div"); ch.className = "hint"; ch.textContent = info.hint; chip.appendChild(ch); }
      panel.appendChild(chip);
    }

    var ready = mode === "none" || (mode === "card" && !!sel.card) || (mode === "session" && !!sel.session);
    var foot = document.createElement("div"); foot.className = "ah-foot";
    var send = document.createElement("button"); send.className = "ah-send";
    send.textContent = info.verb; // the count already rides in the summary line above
    send.disabled = !ready;
    send.onclick = function () { if (ready) submit(); };
    foot.appendChild(send);
    // Handoff is an ESCAPE HATCH, not a peer of sending — a full-width button made it read like one.
    var copy = document.createElement("button"); copy.className = "ah-link";
    copy.textContent = "Copiar handoff (markdown)"; copy.onclick = copyHandoff;
    foot.appendChild(copy);
    panel.appendChild(foot);
  }

  var pins = [];
  var picking = false;
  // THE PANEL HAS TWO SCREENS, because it has two jobs: "what did I mark" (collect) and "where does
  // this go" (send). They used to share one flat stack, so the destination block — three tabs plus a
  // hint, the tallest thing on screen — was shouting at an operator who was still marking. Collect owns
  // the marking mode; send owns the destination and is reachable only with at least one annotation.
  var step = "collect"; // collect | send
  // THE TOOL — "select" (click one element) or "draw" (drag a box). Both gestures used to be live at
  // once, which read as one vague mode: the drag was UNDISCOVERABLE and a click while aiming a box was
  // a surprise capture. Now the mode is explicit, each tool listens to ITS OWN gesture, and the pair is
  // visible on entry so the second one teaches itself. The choice persists for the session.
  var tool = "select";
  var composer = null;
  var panel = null;
  // Region (drag-a-box) capture state. A press that MOVES past DRAG_MIN becomes a region; a plain
  // press stays an element click. suppressClick eats the trailing click after a drag (no click-through).
  var pressAt = null;        // {x,y} of the last mousedown, for EITHER tool — see onClick
  var dragStart = null;      // {x,y} at mousedown while picking
  var dragging = false;      // moved past the threshold → it's a box, not a click
  var suppressClick = false; // a drag just ended → the next click must not element-capture/navigate
  var DRAG_MIN = 8;          // px of movement before a press counts as a region drag

  function esc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&"); }
  function isUi(el) { return !el || (el.closest && el.closest("[data-ah-ui]")); }

  // --- inline styles (no external CSS; CSP-safe) ---
  var style = document.createElement("style");
  style.setAttribute("data-ah-ui", "1");
  style.textContent = [
    ".ah-hl{position:fixed;pointer-events:none;z-index:2147483640;border:2px solid var(--ah-accent);background:var(--ah-accent-soft);border-radius:6px;transition:all .05s}",
    // O RODAPÉ DO HOST é declarado por ele, não adivinhado por nós. Com `bottom:16px` fixo, o botão
    // aterrissava DENTRO da barra de navegação inferior do AgileHarness (56px, `md:hidden`) e —
    // por ter o maior z-index que existe — ROUBAVA O TOQUE de duas das cinco abas em toda tela de
    // celular: tocar em "Início" ou "Inbox" abria o modo de marcação. Cravar 56px aqui estaria errado
    // (este overlay roda em qualquer app); então o host reserva o espaço dele em `--ah-bottom-reserve`
    // e quem não declara nada continua com os 16px de sempre. `env(safe-area-inset-bottom)` cobre o
    // queixo dos aparelhos sem entalhe declarado.
    ".ah-bar{position:fixed;left:16px;bottom:calc(16px + var(--ah-bottom-reserve, 0px) + env(safe-area-inset-bottom, 0px));z-index:2147483646}",
    // O BOTÃO CEDE A VEZ a um diálogo modal. Ele mora no canto inferior esquerdo com o maior z-index que
    // existe — de propósito, para ser alcançável em qualquer app. Só que um painel que assume a tela
    // (`aria-modal`) põe as PRÓPRIAS ações nesse mesmo canto: no celular, o botão cobria o anexo, o
    // medidor de contexto e o seletor de modo da gaveta do chat, que ficavam inclicáveis. Enquanto um
    // modal estiver aberto ele some; ao fechar, volta sozinho. As superfícies ancoradas (o chat da home,
    // que é um rail e não um modal) seguem marcáveis normalmente.
    // `:has()` é progressivo: onde não houver suporte, a regra é ignorada e o comportamento é o de antes.
    'body:has([aria-modal="true"]) .ah-bar,body:has([aria-modal="true"]) .ah-min{display:none}',
    ".ah-btn{display:inline-flex;align-items:center;gap:6px;background:var(--ah-surface);color:var(--ah-fg);border:1px solid var(--ah-line);border-radius:999px;padding:8px 14px;cursor:pointer;box-shadow:0 2px 10px rgba(15,15,15,.10);font:600 13px var(--ah-font)}",
    ".ah-btn:hover{background:var(--ah-surface-hover)}",
    // ESTADO ATIVO — inverte fg/surface em vez de preencher com o acento. O acento é do HOST e pode ser
    // escuro (no produto de origem é): preencher com ele e fixar o texto em quase-preto, como estava, apagava o
    // "Parar" (preto sobre preto). fg×surface é o ÚNICO par que o overlay pode garantir contrastante em
    // qualquer tema e em qualquer app — é o mesmo par do botão de enviar. O acento continua marcando o
    // estado pela borda, onde a cor não precisa carregar texto.
    ".ah-btn.on{background:var(--ah-fg);color:var(--ah-surface);border-color:var(--ah-accent)}",
    ".ah-panel{position:fixed;left:16px;bottom:60px;z-index:2147483646;width:320px;max-height:64vh;overflow:auto;background:var(--ah-surface);border:1px solid var(--ah-line);border-radius:var(--ah-radius);padding:12px;color:var(--ah-fg);font:13px/1.45 var(--ah-font);box-shadow:0 12px 32px rgba(15,15,15,.16)}",
    ".ah-pin{display:flex;gap:8px;align-items:flex-start;border:1px solid var(--ah-line);border-radius:8px;padding:8px 9px;margin:7px 0;background:var(--ah-surface)}",
    ".ah-pin-b{flex:1;min-width:0}",
    ".ah-num{flex:none;min-width:17px;text-align:center;margin-top:1px;border:1px solid var(--ah-line);border-radius:4px;color:var(--ah-fg-subtle);font:700 10px/1.6 var(--ah-mono)}",
    ".ah-pin .n{color:var(--ah-fg);font-size:12.5px;line-height:1.4}",
    ".ah-target{color:var(--ah-fg-subtle);font:11px/1.35 var(--ah-font);word-break:break-word}",
    ".ah-pin .ah-target{display:block;margin-top:4px}",
    ".ah-x{flex:none;border:0;background:transparent;padding:0 2px;cursor:pointer;color:var(--ah-fg-subtle);font-size:12px;line-height:1.4}",
    ".ah-x:hover{color:var(--ah-danger)}",
    ".ah-send{width:100%;box-sizing:border-box;background:var(--ah-fg);color:var(--ah-surface);border:0;border-radius:8px;padding:10px;cursor:pointer;font:600 13px var(--ah-font)}",
    ".ah-send:hover{opacity:.88}",
    // MODAL — a full-viewport flex container is what makes "always fully on screen" structural rather
    // than a clamp that has to guess the card's height (the guess is exactly what used to fail).
    ".ah-modal{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(10,10,12,.5);animation:ah-fade .12s ease-out}",
    "@keyframes ah-fade{from{opacity:0}to{opacity:1}}",
    "@keyframes ah-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}",
    "@media (prefers-reduced-motion:reduce){.ah-modal,.ah-composer{animation:none}}",
    ".ah-composer{width:min(420px,100%);max-height:min(86vh,720px);overflow:auto;box-sizing:border-box;display:flex;flex-direction:column;background:var(--ah-surface);border:1px solid var(--ah-line);border-radius:14px;padding:14px;color:var(--ah-fg);font:13px/1.45 var(--ah-font);box-shadow:0 24px 60px rgba(10,10,12,.34);animation:ah-rise .14s ease-out}",
    // Narrow screens: a bottom sheet. Centring fights the on-screen keyboard, which shrinks the
    // viewport from the bottom and would push a centred card halfway under it.
    "@media (max-width:520px){.ah-modal{align-items:flex-end;padding:0}.ah-composer{width:100%;max-height:88vh;border-radius:16px 16px 0 0;border-bottom:0;padding-bottom:18px}}",
    // Flex items SHRINK by default: past the max-height the textarea and the thumbnail would be
    // squashed to slivers instead of the card scrolling. `flex:none` is what turns the overflow into
    // a scroll — without it `overflow:auto` above never has anything to scroll.
    ".ah-composer>*{flex:none}",
    ".ah-chead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:-2px 0 9px}",
    ".ah-clabel{font:600 10.5px/1.2 var(--ah-mono);letter-spacing:.11em;text-transform:uppercase;color:var(--ah-fg-subtle)}",
    ".ah-tchip{display:flex;gap:7px;align-items:flex-start;background:var(--ah-inset);border:1px solid var(--ah-line);border-radius:8px;padding:7px 9px;margin-bottom:9px}",
    ".ah-tico{flex:none;color:var(--ah-accent);font-size:12px;line-height:1.35}",
    ".ah-composer .ah-target{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;min-width:0;font-size:11.5px;color:var(--ah-fg-muted)}",
    ".ah-composer textarea{width:100%;height:96px;min-height:72px;background:var(--ah-inset);color:var(--ah-fg);border:1px solid var(--ah-line);border-radius:9px;padding:9px 10px;resize:vertical;box-sizing:border-box;font:13.5px/1.5 var(--ah-font);outline:none}",
    ".ah-composer textarea:focus{border-color:var(--ah-accent);box-shadow:0 0 0 2px var(--ah-accent-soft)}",
    ".ah-kbd{margin-top:8px;text-align:center;font:11px/1.4 var(--ah-font);color:var(--ah-fg-subtle)}",
    ".ah-row{display:flex;gap:7px;margin-top:11px}",
    ".ah-row button{flex:1;border:0;border-radius:9px;padding:10px;cursor:pointer;font:600 12.5px var(--ah-font)}",
    ".ah-ok:disabled{opacity:.45;cursor:not-allowed}",
    ".ah-ok{background:var(--ah-fg);color:var(--ah-surface)}.ah-ok:hover{opacity:.88}",
    // `.ah-row button{border:0}` above outranks a bare `.ah-cancel` (class+element beats class), so the
    // secondary button silently lost its outline and read as loose text. Match the specificity.
    ".ah-row .ah-cancel{background:transparent;color:var(--ah-fg-muted);border:1px solid var(--ah-line)}",
    ".ah-row .ah-cancel:hover{background:var(--ah-surface-hover);color:var(--ah-fg)}",
    ".ah-tip{color:var(--ah-fg-subtle);font-size:11px;margin:9px 0 0}",
    ".ah-btn .ah-ic{display:inline-flex;line-height:0}",
    ".ah-btn .ah-ic svg{display:block}",
    ".ah-dest{border:1px solid var(--ah-line);border-radius:8px;padding:7px 9px;margin:2px 0 8px;background:var(--ah-inset)}",
    ".ah-dest .dl{font:600 12px var(--ah-font);color:var(--ah-fg)}",
    ".ah-dest .hint{font-size:11px;color:var(--ah-fg-muted);margin-top:2px;line-height:1.35}",
    ".ah-notice{position:fixed;left:16px;bottom:60px;z-index:2147483647;max-width:320px;box-sizing:border-box;background:var(--ah-surface);color:var(--ah-fg);border:1px solid var(--ah-line);border-radius:var(--ah-radius);padding:10px 12px;font:13px/1.45 var(--ah-font);box-shadow:0 12px 32px rgba(15,15,15,.18)}",
    ".ah-notice a{color:var(--ah-accent);text-decoration:none;font-weight:600}",
    ".ah-notice a:hover{text-decoration:underline}",
    ".ah-notice .close{float:right;cursor:pointer;color:var(--ah-fg-subtle);margin-left:10px}",
    ".ah-notice .close:hover{color:var(--ah-fg)}",
    // --- screen 1: the marking mode as a visible state ---
    ".ah-armed{display:flex;gap:8px;align-items:flex-start;background:var(--ah-accent-soft);border:1px solid var(--ah-accent);border-radius:8px;padding:8px 9px;margin:2px 0 8px;font:600 11.5px/1.4 var(--ah-font);color:var(--ah-fg)}",
    ".ah-armed span{font-weight:500;color:var(--ah-fg-muted)}",
    ".ah-pulse{flex:none;width:8px;height:8px;margin-top:4px;border-radius:50%;background:var(--ah-accent);animation:ah-pulse 1.6s ease-in-out infinite}",
    "@keyframes ah-pulse{0%,100%{opacity:1}50%{opacity:.25}}",
    "@media (prefers-reduced-motion:reduce){.ah-pulse{animation:none}}",
    ".ah-add{width:100%;box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:6px;border:1px dashed var(--ah-line);background:transparent;color:var(--ah-fg-muted);border-radius:8px;padding:9px;cursor:pointer;font:600 12.5px var(--ah-font);margin-top:8px}",
    ".ah-add:hover{border-color:var(--ah-accent);color:var(--ah-fg);background:var(--ah-accent-soft)}",
    // STICKY: the panel scrolls (a card picker alone is 184px), and the one action that finishes the
    // job must never be the thing below the fold. `bottom:-12px` cancels the panel's own padding so it
    // sits flush on the bottom edge; the opaque background is what makes content scroll UNDER it.
    ".ah-foot{position:sticky;bottom:-12px;z-index:1;margin-top:11px;padding:10px 0 12px;background:var(--ah-surface);border-top:1px solid var(--ah-line);display:flex;flex-direction:column;gap:6px}",
    // --- screen 2: destination ---
    ".ah-back{align-self:flex-start;border:0;background:transparent;color:var(--ah-fg-muted);cursor:pointer;font:600 12px var(--ah-font);padding:0 0 8px}",
    ".ah-back:hover{color:var(--ah-fg)}",
    ".ah-summary{display:flex;align-items:center;justify-content:space-between;gap:8px;background:var(--ah-inset);border:1px solid var(--ah-line);border-radius:8px;padding:8px 10px;font-size:12.5px;color:var(--ah-fg)}",
    ".ah-revise{border:0;background:transparent;color:var(--ah-accent);cursor:pointer;font:600 12px var(--ah-font);padding:0}",
    ".ah-revise:hover{text-decoration:underline}",
    ".ah-label{margin:11px 0 6px;font:600 10.5px/1.2 var(--ah-mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ah-fg-subtle)}",
    ".ah-dests{display:flex;flex-direction:column;gap:6px;margin-bottom:8px}",
    ".ah-dest-row{display:flex;gap:9px;align-items:flex-start;text-align:left;width:100%;box-sizing:border-box;border:1px solid var(--ah-line);background:var(--ah-surface);border-radius:9px;padding:9px 10px;cursor:pointer}",
    ".ah-dest-row:hover{background:var(--ah-surface-hover)}",
    ".ah-dest-row.on{border-color:var(--ah-accent);background:var(--ah-accent-soft)}",
    ".ah-radio{flex:none;width:13px;height:13px;margin-top:2px;border-radius:50%;border:1.5px solid var(--ah-line)}",
    ".ah-dest-row.on .ah-radio{border-color:var(--ah-accent);box-shadow:inset 0 0 0 3px var(--ah-accent)}",
    ".ah-dest-b{display:flex;flex-direction:column;gap:2px;min-width:0}",
    ".ah-dest-l{font:600 12.5px var(--ah-font);color:var(--ah-fg)}",
    ".ah-dest-s{font:11px/1.4 var(--ah-font);color:var(--ah-fg-subtle)}",
    ".ah-link{width:100%;border:0;background:transparent;color:var(--ah-fg-muted);cursor:pointer;font:600 12px var(--ah-font);padding:6px}",
    ".ah-link:hover{color:var(--ah-fg);text-decoration:underline}",
    ".ah-search{width:100%;box-sizing:border-box;background:var(--ah-inset);color:var(--ah-fg);border:1px solid var(--ah-line);border-radius:8px;padding:7px 8px;font:12px var(--ah-font);outline:none;margin-bottom:6px}",
    ".ah-search:focus{border-color:var(--ah-accent);box-shadow:0 0 0 2px var(--ah-accent-soft)}",
    ".ah-list{max-height:184px;overflow:auto;border:1px solid var(--ah-line);border-radius:8px;margin-bottom:8px}",
    ".ah-opt{padding:7px 9px;cursor:pointer;border-bottom:1px solid var(--ah-line);position:relative}",
    ".ah-opt:last-child{border-bottom:0}",
    ".ah-opt:hover{background:var(--ah-surface-hover)}",
    ".ah-opt.on{background:var(--ah-accent-soft)}",
    ".ah-opt-l{font:600 12px var(--ah-font);color:var(--ah-fg);word-break:break-word;padding-right:46px}",
    ".ah-opt-s{font-size:11px;color:var(--ah-fg-subtle);margin-top:1px}",
    // mesmo defeito do estado ativo: texto fixo sobre o acento do host. Invertido pelo par garantido.
    ".ah-busy{position:absolute;right:8px;top:7px;font-size:10px;font-weight:600;color:var(--ah-surface);background:var(--ah-fg);border-radius:5px;padding:1px 6px}",
    ".ah-msg{padding:9px;font-size:12px;color:var(--ah-fg-subtle);text-align:center}",
    ".ah-warn{font-size:11px;color:var(--ah-fg-muted);background:var(--ah-inset);border:1px solid var(--ah-line);border-radius:8px;padding:7px 9px;margin:2px 0 8px;line-height:1.35}",
    ".ah-send:disabled{cursor:not-allowed;opacity:.5}",
    ".ah-head{display:flex;align-items:center;justify-content:space-between;margin:-2px 0 8px}",
    ".ah-htitle{font:600 12px var(--ah-font);color:var(--ah-fg-muted)}",
    ".ah-hacts{display:flex;gap:2px}",
    ".ah-hbtn{width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:var(--ah-fg-subtle);border-radius:6px;cursor:pointer;font:600 16px var(--ah-font);line-height:1}",
    ".ah-hbtn:hover{background:var(--ah-surface-hover);color:var(--ah-fg)}",
    ".ah-min{position:fixed;left:16px;bottom:60px;z-index:2147483646;background:var(--ah-surface);color:var(--ah-fg-muted);border:1px solid var(--ah-line);border-radius:999px;padding:6px 12px;cursor:pointer;font:600 12px var(--ah-font);box-shadow:0 2px 10px rgba(15,15,15,.10)}",
    ".ah-min:hover{background:var(--ah-surface-hover);color:var(--ah-fg)}",
    ".ah-danger{background:var(--ah-danger);color:#fff}.ah-danger:hover{opacity:.9}",
    ".ah-shot{display:flex;align-items:center;gap:8px;margin-top:11px;padding:8px 10px;border:1px solid var(--ah-line);border-radius:9px;background:var(--ah-inset);font:600 12px var(--ah-font);color:var(--ah-fg);cursor:pointer;user-select:none}",
    ".ah-shot input{accent-color:var(--ah-accent);cursor:pointer}",
    ".ah-shot input:disabled{cursor:default}",
    // Capped: a tall screenshot used to stretch the box to the length of the picture. `contain` keeps
    // the preview honest — a cropped preview would hide the very part the operator is pointing at.
    ".ah-thumb{display:none;width:100%;max-height:190px;object-fit:contain;margin-top:7px;border:1px solid var(--ah-line);border-radius:9px;background:var(--ah-inset)}",
    ".ah-tools{display:flex;gap:6px;margin:2px 0 7px}",
    ".ah-tool{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;border:1px solid var(--ah-line);background:var(--ah-surface);border-radius:9px;padding:9px 6px 8px;cursor:pointer;color:var(--ah-fg-muted);font:600 11px var(--ah-font)}",
    ".ah-tool:hover{background:var(--ah-surface-hover);color:var(--ah-fg)}",
    ".ah-tool.on{border-color:var(--ah-accent);background:var(--ah-accent-soft);color:var(--ah-fg)}",
    ".ah-tool svg{display:block}",
    ".ah-toolhint{font-size:11px;color:var(--ah-fg-subtle);line-height:1.4;margin:0 0 8px}",
    // A REGRA DE INVISIBILIDADE da captura. Vale para TUDO que é nosso (`[data-ah-ui]`) e é aplicada
    // pela classe na RAIZ, não nó a nó — ver withChromeHidden. `visibility` e não `display` porque
    // `display:none` reflowaria a página PARA DENTRO da foto.
    //
    // MENOS o <video> do stream (`data-ah-frame`), que é a FONTE do frame, não chrome: ele já mora
    // fora da viewport (left:-99999px, opacity:0), então nunca sairia na foto — e esconder por
    // `visibility` um elemento de mídia é pedir para o compositor parar de apresentá-lo, o que
    // silenciaria justamente o `requestVideoFrameCallback` que estamos esperando.
    "html.ah-shooting [data-ah-ui]:not([data-ah-frame]){visibility:hidden !important}",
  ].join("");
  document.head.appendChild(style);

  var hl = document.createElement("div");
  hl.className = "ah-hl"; hl.setAttribute("data-ah-ui", "1"); hl.style.display = "none";
  document.body.appendChild(hl);

  var bar = document.createElement("div");
  bar.className = "ah-bar"; bar.setAttribute("data-ah-ui", "1");
  var toggle = document.createElement("button");
  toggle.className = "ah-btn";
  bar.appendChild(toggle);
  document.body.appendChild(bar);

  // --- selector synthesis (grep-friendly, bounded depth) ---
  function cssSelector(el) {
    if (!(el instanceof Element)) return "";
    if (el.id) return "#" + esc(el.id);
    var parts = [];
    var node = el;
    for (var depth = 0; node && node.nodeType === 1 && depth < 5; depth++) {
      var tag = node.tagName.toLowerCase();
      if (tag === "html" || tag === "body") break;
      if (node.id) { parts.unshift("#" + esc(node.id)); break; }
      var sel = tag;
      var cls = (node.className && typeof node.className === "string")
        ? node.className.trim().split(/\s+/).filter(function (c) { return c && !/^ah-/.test(c) && c.length < 30; }).slice(0, 2)
        : [];
      if (cls.length) sel += "." + cls.map(esc).join(".");
      var parent = node.parentElement;
      if (parent) {
        var sameTag = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
        if (sameTag.length > 1) sel += ":nth-of-type(" + (sameTag.indexOf(node) + 1) + ")";
      }
      parts.unshift(sel);
      node = parent;
    }
    return parts.join(" > ");
  }

  function anchorFor(el) {
    var r = el.getBoundingClientRect();
    var cls = (el.className && typeof el.className === "string")
      ? el.className.trim().split(/\s+/).filter(function (c) { return c && !/^ah-/.test(c); }) : [];
    var sel = cssSelector(el) || el.tagName.toLowerCase(); // never empty (a body/html click would else void the whole batch)
    var a = {
      selector: sel,
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.textContent || "").trim().slice(0, 160) || undefined,
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      url: location.href,
      route: location.pathname,
    };
    if (cls.length) a.classes = cls;
    if (el.id) a.elementId = el.id;
    return a;
  }

  // --- REGION (drag-a-box) capture: the box geometry + the smallest element that CONTAINS it (the
  //     container the operator is pointing at → the required selector) + the notable elements the box
  //     OVERLAPS (so the card points at more than the container). Our own UI is skipped everywhere. ---
  function elAt(x, y) { var el = document.elementFromPoint(x, y); return isUi(el) ? null : el; }
  function labelOf(el) {
    var t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    return t ? (t.length > 40 ? t.slice(0, 40) + "…" : t) : "<" + el.tagName.toLowerCase() + ">";
  }
  function containerFor(box) {
    var cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    var node = elAt(cx, cy) || document.body;
    for (var d = 0; node && node.nodeType === 1 && d < 12; d++) {
      if (node === document.body || node === document.documentElement) break;
      var r = node.getBoundingClientRect();
      if (r.left <= box.x + 1 && r.top <= box.y + 1 && r.right >= box.x + box.w - 1 && r.bottom >= box.y + box.h - 1) return node;
      node = node.parentElement;
    }
    return elAt(cx, cy) || document.body;
  }
  function coveredFor(box, container) {
    var seen = [], out = [], cols = 3, rows = 3, gx, gy;
    for (gy = 0; gy < rows; gy++) for (gx = 0; gx < cols; gx++) {
      var el = elAt(box.x + (box.w * (gx + 0.5)) / cols, box.y + (box.h * (gy + 0.5)) / rows);
      if (!el || el === container || seen.indexOf(el) >= 0) continue;
      if (container.contains && !container.contains(el)) continue;
      seen.push(el);
      out.push({ selector: cssSelector(el) || el.tagName.toLowerCase(), label: labelOf(el) });
      if (out.length >= 12) return out;
    }
    return out;
  }
  function anchorForRegion(box, container) {
    container = container || containerFor(box);
    var covered = coveredFor(box, container);
    var a = {
      selector: cssSelector(container) || (container.tagName ? container.tagName.toLowerCase() : "body"),
      tag: container.tagName ? container.tagName.toLowerCase() : undefined,
      region: true,
      rect: { x: box.x, y: box.y, w: box.w, h: box.h },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      url: location.href,
      route: location.pathname,
    };
    var ct = (container.innerText || container.textContent || "").trim().slice(0, 160);
    if (ct) a.text = ct;
    if (container.id) a.elementId = container.id;
    if (covered.length) a.covered = covered;
    return a;
  }

  // --- DISPLAY CAPTURE: one dialog per session, then every region is a frame grab. ---
  var displayStream = null;   // kept alive across captures — THAT is what makes it one dialog, not N
  var displayVideo = null;    // <video> playing the stream; the frame source for drawImage
  var displayState = "idle";  // idle | ready | denied | unusable

  /** Classe na RAIZ enquanto o frame é colhido — a regra que a acompanha esconde todo `[data-ah-ui]`. */
  var SHOOTING_CLS = "ah-shooting";
  /** Teto de espera por um frame limpo. Generoso de propósito: a captura roda em segundo plano com o
   *  compositor já aberto, então esperar não trava gesto nenhum — o polegar da foto só chega depois.
   *  Estourar o teto NÃO cancela a captura (a anotação nunca se perde por causa de uma imagem); o custo
   *  de um stream travado é uma foto possivelmente suja, o mesmo que havia antes em todo frame. */
  var FRAME_WAIT_MAX_MS = 1200;
  /** Sem `captureTime`: quantos frames APRESENTADOS esperar. Quatro cobre a profundidade típica do
   *  pipeline do Chromium com folga — dois (o valor antigo) era a própria falha. */
  var FRAME_WAIT_COUNT = 4;
  /** Sem `requestVideoFrameCallback` nenhum: espera de relógio, o único sinal que resta. */
  var FRAME_WAIT_BLIND_MS = 260;

  /** PNG, or JPEG when the PNG would blow the store's cap (a screen region of photos encodes badly). */
  function encodeCanvas(canvas) {
    var url = canvas.toDataURL("image/png");
    if (url.length * 0.75 > MAX_SHOT_BYTES) url = canvas.toDataURL("image/jpeg", 0.85);
    return url;
  }

  /** Two frames: one for the style change to be applied, one for it to have been PAINTED — a single
   *  rAF can hand back a frame the hidden chrome is still in. */
  function nextPaint() {
    return new Promise(function (r) {
      requestAnimationFrame(function () { requestAnimationFrame(function () { r(); }); });
    });
  }

  /**
   * Wait for the CAPTURE STREAM to deliver a frame that was CAPTURED AFTER our chrome came off screen.
   *
   * This is the difference between hiding the chrome and the grab actually not containing it. A rAF
   * only tells us the DOM was painted; the getDisplayMedia pipeline runs several frames behind the
   * compositor, so `drawImage` right after a paint reads a frame captured BEFORE the change — which is
   * how the panel and the selection highlight ended up baked into saved screenshots.
   *
   * The ruler is `metadata.captureTime` — the instant the SOURCE captured that frame, on the same
   * `performance.now()` clock as `t0` — so "this frame is clean" is a fact, not an estimate. COUNTING
   * frames was the previous attempt and it is a guess about pipeline depth: two frames is enough on an
   * idle 60Hz tab and not enough on a busy one, and the failure mode is silent (a picture of the tool).
   * `captureTime` is only populated for locally-sourced MediaStream frames, so where it is missing we
   * still count — generously, and never fewer than the old guess.
   */
  function nextCleanFrame() {
    var v = displayVideo;
    var t0 = performance.now();
    if (!v || typeof v.requestVideoFrameCallback !== "function") {
      // No per-frame clock (older Safari/Firefox): a wall-clock wait is the honest fallback — longer
      // than a rAF, short enough not to feel like a hang.
      return new Promise(function (r) { setTimeout(r, FRAME_WAIT_BLIND_MS); });
    }
    return new Promise(function (resolve) {
      var done = false, seen = 0;
      // Liveness backstop: a stream that stalls (tab hidden, source paused) must not hang the capture
      // forever — an annotation is never worth losing over a picture.
      var t = setTimeout(function () { if (!done) { done = true; resolve(); } }, FRAME_WAIT_MAX_MS);
      function finish() { done = true; clearTimeout(t); resolve(); }
      (function step() {
        v.requestVideoFrameCallback(function (_now, meta) {
          if (done) return;
          seen++;
          var captured = meta && typeof meta.captureTime === "number" ? meta.captureTime : null;
          // NOTE: `presentationTime` is deliberately NOT accepted as a substitute. It is the moment the
          // frame was submitted for composition, always >= captureTime — so a frame whose CONTENT is
          // older than t0 can still carry a presentationTime newer than it. That is exactly the false
          // positive this function exists to avoid.
          if (captured != null ? captured >= t0 : seen >= FRAME_WAIT_COUNT) return finish();
          step();
        });
      })();
    });
  }

  /**
   * Our own UI must not appear in a REAL screenshot. A DOM rasterizer could exclude it by selector; a
   * frame grab has no such luxury — it photographs whatever is on screen.
   *
   * Hidden by a CLASS ON THE ROOT (`.ah-shooting`, whose rule hits every `[data-ah-ui]`), never by
   * walking a list of nodes and setting inline styles on each. The list version had a hole with teeth:
   * `render()` REBUILDS the panel — the old node is removed and a NEW one appended on every state
   * change — so any re-render inside the wait window put a brand-new, fully visible panel on screen
   * while the capture was still waiting for a clean frame, and the tool photographed itself. A class on
   * the root applies to whatever is in the DOM at PAINT time, including nodes that did not exist when
   * the capture started; and restoring is one `classList.remove`, so there is no per-node previous
   * value to get wrong either.
   *
   * The composer is covered by the same rule ON PURPOSE: it is open by the time the frame is grabbed
   * (it must not wait on a permission dialog the operator may take seconds to answer), so it would
   * otherwise sit right on top of the region being photographed.
   */
  function withChromeHidden(fn) {
    var root = document.documentElement;
    function restore() { root.classList.remove(SHOOTING_CLS); }
    root.classList.add(SHOOTING_CLS);
    return nextPaint()
      .then(nextCleanFrame)
      .then(fn)
      .then(
        function (v) { restore(); return v; },
        function (e) { restore(); throw e; },
      );
  }

  /** Is this stream croppable? We map VIEWPORT coordinates onto the frame, which only holds if the
   *  frame IS the tab viewport. Two independent checks because `displaySurface` isn't reported
   *  everywhere: the reported surface, and the aspect ratio (a shared window/monitor includes browser
   *  chrome or other apps, so its ratio diverges). A wrong surface silently produces a crop of the
   *  WRONG PART OF THE SCREEN — worse than no image — so we refuse it. */
  function usableSurface(track, video) {
    var s = track.getSettings ? track.getSettings() : {};
    if (s.displaySurface && s.displaySurface !== "browser") return false;
    var want = window.innerWidth / window.innerHeight;
    var got = video.videoWidth / video.videoHeight;
    if (!want || !got) return false;
    return Math.abs(got - want) / want <= 0.15;
  }

  function releaseDisplay() {
    if (displayStream) displayStream.getTracks().forEach(function (t) { t.stop(); });
    if (displayVideo) displayVideo.remove();
    displayStream = null; displayVideo = null;
    if (displayState === "ready") displayState = "idle";
  }

  /**
   * The live <video>, asking for the stream on FIRST use. MUST be called from a user-gesture stack
   * (the mouseup that ends the drag) — getDisplayMedia requires transient activation.
   * A refusal is remembered for the session (`denied`): re-prompting on every drag would be hostile.
   */
  function ensureDisplayVideo() {
    if (displayVideo && displayStream && displayStream.active) return Promise.resolve(displayVideo);
    if (!displayCaptureEnabled || displayState === "denied" || displayState === "unusable") return Promise.resolve(null);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return Promise.resolve(null);
    // A permission promise that never settles (a dialog left open, a browser that ignores the call)
    // must not leave the composer claiming "capturando…" forever. Generous, because a human reading the
    // dialog is legitimately slow — this is a liveness backstop, not a deadline.
    var settled = false;
    var timeout = new Promise(function (resolve) {
      setTimeout(function () { if (!settled) { displayState = "denied"; resolve(null); } }, 45000);
    });
    var ask = navigator.mediaDevices
      .getDisplayMedia({
        // `preferCurrentTab` (Chromium) puts THIS tab in the dialog already selected — the difference
        // between "one click" and "find your tab in a grid". Ignored elsewhere, hence also the hint.
        video: { displaySurface: "browser" },
        preferCurrentTab: true,
        selfBrowserSurface: "include",
        surfaceSwitching: "exclude",
        audio: false,
      })
      .then(function (stream) {
        var v = document.createElement("video");
        v.setAttribute("data-ah-ui", "1");
        // …e a marca que o ISENTA da regra de invisibilidade da captura (ver a folha de estilo).
        v.setAttribute("data-ah-frame", "1");
        v.muted = true; v.playsInline = true;
        v.style.cssText = "position:fixed;left:-99999px;top:0;width:1px;height:1px;opacity:0";
        v.srcObject = stream;
        document.body.appendChild(v);
        return v.play().then(function () {
          return new Promise(function (resolve) {
            // videoWidth is 0 until the first frame is decoded
            if (v.videoWidth) return resolve();
            v.addEventListener("loadeddata", function () { resolve(); }, { once: true });
            setTimeout(resolve, 1500);
          }).then(function () {
            var track = stream.getVideoTracks()[0];
            if (!track || !usableSurface(track, v)) {
              stream.getTracks().forEach(function (t) { t.stop(); });
              v.remove();
              displayState = "unusable";
              flash("Compartilhe a ABA para capturar a imagem — anotação segue sem foto.");
              return null;
            }
            // The operator can stop sharing from the browser's own bar; next capture re-asks.
            track.addEventListener("ended", function () { releaseDisplay(); });
            displayStream = stream; displayVideo = v; displayState = "ready";
            return v;
          });
        });
      })
      .catch(function () { displayState = "denied"; return null; });
    return Promise.race([ask, timeout]).then(function (v) { settled = true; return v; });
  }

  /** Clamp a box to the visible viewport — the frame only contains what is ON SCREEN, so source
   *  coordinates outside it would read garbage (or nothing) instead of the element. Matters for an
   *  element taller than the window, or one scrolled half out of view. */
  function clampToViewport(b) {
    var x = Math.max(0, b.x), y = Math.max(0, b.y);
    var w = Math.min(window.innerWidth, b.x + b.w) - x;
    var h = Math.min(window.innerHeight, b.y + b.h) - y;
    return { x: x, y: y, w: Math.max(0, w), h: Math.max(0, h) };
  }

  /** The box to photograph for a CLICKED element. Its own rect, plus breathing room — and a floor,
   *  because a 20×20 icon cropped to itself is a picture of nothing: the operator needs to recognise
   *  WHERE it is. The anchor still points at the element exactly; only the framing is generous. */
  function boxForElement(rect) {
    var PAD = 10, MIN_W = 180, MIN_H = 110;
    var x = rect.x - PAD, y = rect.y - PAD, w = rect.w + PAD * 2, h = rect.h + PAD * 2;
    if (w < MIN_W) { x -= (MIN_W - w) / 2; w = MIN_W; }
    if (h < MIN_H) { y -= (MIN_H - h) / 2; h = MIN_H; }
    return clampToViewport({ x: x, y: y, w: w, h: h });
  }

  /** Grab a box out of the live frame. Viewport coords map onto the frame by a single scale because
   *  the surface check above guarantees the frame IS the viewport. Serves BOTH capture gestures — a
   *  drawn region and a clicked element (which supplies its own rect). Always resolves — an image is
   *  an ENRICHMENT, never a precondition for the annotation. */
  function captureRegionImage(box) {
    if (!canCaptureImage || !box.w || !box.h) return Promise.resolve(null);
    return ensureDisplayVideo()
      .then(function (video) {
        if (!video || !video.videoWidth) return null;
        return withChromeHidden(function () {
          var sx = video.videoWidth / window.innerWidth;
          var sy = video.videoHeight / window.innerHeight;
          var shrink = Math.min(1, MAX_SHOT_EDGE / Math.max(box.w, box.h));
          var out = document.createElement("canvas");
          out.width = Math.max(1, Math.round(box.w * sx * shrink));
          out.height = Math.max(1, Math.round(box.h * sy * shrink));
          out.getContext("2d").drawImage(
            video,
            box.x * sx, box.y * sy, box.w * sx, box.h * sy,
            0, 0, out.width, out.height,
          );
          return encodeCanvas(out);
        });
      })
      .catch(function () { return null; });
  }

  /** A pasted image (system screenshot) → a bounded data URL. Same ceiling as a captured region, so
   *  the store sees one shape whatever the source. */
  function imageFromBlob(blob) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var shrink = Math.min(1, MAX_SHOT_EDGE / Math.max(img.width, img.height));
        var out = document.createElement("canvas");
        out.width = Math.max(1, Math.round(img.width * shrink));
        out.height = Math.max(1, Math.round(img.height * shrink));
        out.getContext("2d").drawImage(img, 0, 0, out.width, out.height);
        resolve(encodeCanvas(out));
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  // POST one PNG out-of-band; resolves to its same-origin URL (or null). The batch itself stays
  // bytes-free — only this URL rides in anchor.screenshotRef.
  function uploadShot(dataUrl) {
    return fetch(shotEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ dataUrl: dataUrl }),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) { return j && j.ok && typeof j.url === "string" ? j.url : null; })
      .catch(function () { return null; });
  }

  // A human label for a captured element — its visible text (collapsed) else its tag. The raw CSS
  // selector still travels in the batch payload (that's how the card re-finds the element); the UI
  // only ever shows THIS, never the selector path (technical noise the operator didn't ask for).
  function targetLabel(anchor) {
    if (anchor && anchor.region) {
      var n = (anchor.covered && anchor.covered.length) || 0;
      var dims = anchor.rect ? Math.round(anchor.rect.w) + "×" + Math.round(anchor.rect.h) : "";
      return "Região " + dims + (n ? " · " + n + (n === 1 ? " elemento" : " elementos") : "");
    }
    var t = (anchor && anchor.text ? String(anchor.text) : "").replace(/\s+/g, " ").trim();
    if (t) return t.length > 60 ? t.slice(0, 60) + "…" : t;
    return "<" + ((anchor && anchor.tag) || "elemento") + ">";
  }

  function onMove(e) {
    if (!picking) return;
    // The composer OWNS the gesture while it is open. Marking now stays armed across captures, so
    // without this the page would keep outlining elements behind a note the operator is still writing.
    if (composer) { hl.style.display = "none"; return; }
    if (dragStart && !(e.buttons & 1)) { dragStart = null; dragging = false; } // button released off-page
    if (dragStart) {
      var dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
      if (!dragging && Math.abs(dx) + Math.abs(dy) < DRAG_MIN) { hl.style.display = "none"; return; }
      dragging = true; // draw the region rubber-band instead of the element highlight
      hl.style.display = "block";
      hl.style.left = Math.min(dragStart.x, e.clientX) + "px"; hl.style.top = Math.min(dragStart.y, e.clientY) + "px";
      hl.style.width = Math.abs(dx) + "px"; hl.style.height = Math.abs(dy) + "px";
      return;
    }
    // The element outline belongs to the SELECT tool. In draw mode it would promise a capture that
    // tool won't make — the box is the only thing that will be captured there.
    if (tool !== "select") { hl.style.display = "none"; return; }
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (isUi(el) || !el) { hl.style.display = "none"; return; }
    var r = el.getBoundingClientRect();
    hl.style.display = "block";
    hl.style.left = r.left + "px"; hl.style.top = r.top + "px";
    hl.style.width = r.width + "px"; hl.style.height = r.height + "px";
  }

  function onClick(e) {
    // Eat the trailing click after a region drag (picking is already off by then) so the box can't
    // click-through to a link/button underneath.
    if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); return; }
    if (!picking) return;
    // A note being written wins over a new capture — see onMove.
    if (composer) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (isUi(el) || !el) return;
    // Swallow the click for BOTH tools — while marking, a click must never reach the page (a link
    // would navigate away and take the pending annotations with it).
    e.preventDefault(); e.stopPropagation();
    // In DRAW mode a click is not the gesture — say so instead of doing nothing, which reads as broken.
    if (tool !== "select") { pressAt = null; flash("Arraste para desenhar a área."); return; }
    // …and the mirror image: a press that MOVED is a drag, not a click. The browser still dispatches a
    // click (on the common ancestor of the two targets), which would capture whatever sits under the
    // RELEASE point — a capture the operator never aimed at. Refuse it and name the other tool.
    var moved = pressAt && Math.abs(e.clientX - pressAt.x) + Math.abs(e.clientY - pressAt.y) >= DRAG_MIN;
    pressAt = null;
    if (moved) { flash("Esta ferramenta captura no clique — use Desenhar para marcar uma área."); return; }
    // Marking STAYS ARMED. It used to switch itself off right here, so the second annotation had no
    // visible way in — the only door left was the launcher button in the corner, which reads as "open
    // the tool", not "add another". The mode now ends where the operator says so: the toggle, or send.
    var a = anchorFor(el);
    // An element click gets its picture too — the rect IS a box, so it is the same frame grab as a
    // drawn region. Started HERE, inside the click handler, because getDisplayMedia needs this
    // gesture's transient activation. Falling back to "cole um print" was only ever a gap.
    openComposer(a, a.rect ? captureRegionImage(boxForElement(a.rect)) : null);
  }

  // While picking, swallow the mousedown on a page element so it can't grab focus — the browser
  // scrolls a newly-focused element into view, which was the "scroll jumps when I click" glitch.
  // We only preventDefault (focus/selection/drag); the click still fires and the composer then
  // focuses with preventScroll. UI elements (the panel) are exempted so their buttons keep working.
  function onMouseDown(e) {
    if (!picking) return;
    if (composer) return; // see onMove — an open note owns the gesture
    suppressClick = false; // a fresh press clears any stale suppression from a lost mouseup
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (isUi(el) || !el) return;
    // Only the DRAW tool arms a drag; SELECT still swallows the press (that preventDefault is the
    // scroll-jump fix — a focused element gets scrolled into view by the browser).
    pressAt = { x: e.clientX, y: e.clientY };
    if (tool === "draw") { dragStart = { x: e.clientX, y: e.clientY }; dragging = false; }
    e.preventDefault();
  }

  // Release: a real drag → capture the REGION (the box); a plain press → let onClick capture the
  // single element under the pointer. Either way, clear the drag state.
  function onMouseUp(e) {
    if (!picking || !dragStart) { dragStart = null; dragging = false; return; }
    var wasDrag = dragging;
    var x = Math.min(dragStart.x, e.clientX), y = Math.min(dragStart.y, e.clientY);
    var w = Math.abs(e.clientX - dragStart.x), h = Math.abs(e.clientY - dragStart.y);
    dragStart = null; dragging = false; hl.style.display = "none";
    if (wasDrag) {
      // Eat the click that trails THIS gesture (so the box can't click through to a link underneath).
      // Self-limiting on purpose: a drag whose press and release land on DIFFERENT elements produces NO
      // trailing click, and the flag would then sit armed and swallow the operator's next real click —
      // which was "Salvar" in the composer. A macrotask fires after any trailing click of this gesture
      // and long before a human's next one, so the flag can never outlive the gesture that set it.
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 0);
      // Stays armed, same as the element click above — one drawn region does not end the session.
      var box = { x: x, y: y, w: w, h: h };
      var anchor = anchorForRegion(box, containerFor(box));
      box = clampToViewport(box);
      // Start the capture INSIDE this gesture's call stack — getDisplayMedia requires transient user
      // activation, so it cannot wait. But the composer opens IMMEDIATELY, never gated on that promise:
      // a permission dialog the operator ignores must not swallow the annotation. The composer being
      // on screen during the grab is handled by hiding it (see withChromeHidden).
      openComposer(anchor, captureRegionImage(box));
    }
  }

  /**
   * The note editor, as a CENTERED MODAL.
   *
   * It used to be a popover pinned to the click point, clamped against a HARDCODED 300×190 guess of
   * its own size. Two things broke that: a composer carrying a screenshot thumbnail is more than twice
   * that tall, and the thumbnail only arrives AFTER the frame grab resolves — so the box was placed,
   * then grew past the bottom edge. Being `position:fixed`, scrolling could not bring it back: the
   * annotation became unreachable and the only way out was Escape. A modal cannot go off-screen, so
   * the whole class of bug is gone rather than re-tuned. Centered on desktop, bottom sheet on narrow
   * screens (thumb reach, and it survives the on-screen keyboard).
   */
  function openComposer(anchor, shotPromise) {
    closeComposer();
    // The element outline is a HOVER affordance; with the dialog up there is nothing to hover, and it
    // would just sit there framing the page behind the modal. (onMove keeps it off while we're open.)
    hl.style.display = "none";
    // `composer` is the BACKDROP wrapper, not the card — withChromeHidden hides it by identity, so the
    // dimming can never end up baked into a captured frame.
    composer = document.createElement("div");
    composer.className = "ah-modal"; composer.setAttribute("data-ah-ui", "1");
    var card = document.createElement("div");
    card.className = "ah-composer";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-label", "Descrever o ajuste");
    composer.appendChild(card);

    var head = document.createElement("div"); head.className = "ah-chead";
    var htl = document.createElement("span"); htl.className = "ah-clabel"; htl.textContent = "Novo ajuste";
    var hx = document.createElement("button"); hx.type = "button"; hx.className = "ah-hbtn";
    hx.textContent = "✕"; hx.title = "Cancelar"; hx.setAttribute("aria-label", "Cancelar");
    head.appendChild(htl); head.appendChild(hx);
    card.appendChild(head);

    // The target as a CHIP: it is evidence of what you clicked, not a caption — it earns a border.
    var tgt = document.createElement("div"); tgt.className = "ah-tchip";
    var tico = document.createElement("span"); tico.className = "ah-tico"; tico.textContent = "⌖";
    var ttxt = document.createElement("span"); ttxt.className = "ah-target"; ttxt.textContent = targetLabel(anchor);
    tgt.appendChild(tico); tgt.appendChild(ttxt);

    var ta = document.createElement("textarea"); ta.placeholder = "O que mudar aqui?";
    var row = document.createElement("div"); row.className = "ah-row";
    var ok = document.createElement("button"); ok.type = "button"; ok.className = "ah-ok"; ok.textContent = "Salvar ajuste";
    var cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "ah-cancel"; cancel.textContent = "Cancelar";
    row.appendChild(ok); row.appendChild(cancel);
    // An empty note used to silently re-focus on click, which reads as a dead button. Say it with state.
    ok.disabled = true;
    ta.addEventListener("input", function () { ok.disabled = !ta.value.trim(); });
    card.appendChild(tgt); card.appendChild(ta);

    // IMAGE. Two sources, one UI: a region arrives with its frame already grabbed (`capturedShot`),
    // and ANY annotation — element included — can receive a pasted system screenshot. Sending it is
    // opt-OUT (checked by default, per the operator's call). With no image we show a one-line hint
    // instead of a checkbox that would send nothing; the hint is also what teaches the paste path
    // when display capture was denied.
    var shot = null;
    var pending = !!shotPromise; // a region is capturing; an element annotation starts with nothing
    var shotBox = null, shotChk = null, thumb = null, hint = null;

    function clearImageUi() {
      [shotBox, thumb, hint].forEach(function (n) { if (n) n.remove(); });
      shotBox = shotChk = thumb = hint = null;
    }
    function paintImageUi() {
      clearImageUi();
      if (!canCaptureImage) return;
      if (!shot) {
        hint = document.createElement("div");
        hint.className = "ah-tip";
        hint.textContent = pending ? "Capturando imagem…" : "Cole um print (Ctrl+V) para anexar uma imagem.";
        card.insertBefore(hint, row);
        return;
      }
      shotBox = document.createElement("label"); shotBox.className = "ah-shot";
      shotChk = document.createElement("input"); shotChk.type = "checkbox"; shotChk.checked = true;
      var txt = document.createElement("span"); txt.textContent = "Enviar imagem";
      shotBox.appendChild(shotChk); shotBox.appendChild(txt);
      thumb = document.createElement("img"); thumb.className = "ah-thumb"; thumb.alt = "";
      thumb.src = shot; thumb.style.display = "block";
      card.insertBefore(shotBox, row);
      card.insertBefore(thumb, row);
    }

    card.appendChild(row);
    var kbd = document.createElement("div"); kbd.className = "ah-kbd";
    // The shortcut used to live in the placeholder — where it vanishes the moment you start typing,
    // i.e. exactly when it becomes useful.
    kbd.textContent = "Cmd/Ctrl+Enter salva · Esc cancela";
    card.appendChild(kbd);
    paintImageUi();

    if (shotPromise) {
      shotPromise.then(function (dataUrl) {
        if (!composer || !composer.isConnected) return; // closed while the frame was being grabbed
        pending = false;
        // A capture NEVER overwrites something the operator pasted in the meantime — a hand-framed
        // screenshot is a stronger signal than our automatic grab.
        if (dataUrl && !shot) shot = dataUrl;
        paintImageUi();
      });
    }

    // Paste anywhere in the composer: the clipboard image wins over whatever was captured (the
    // operator went and framed it by hand — that is a stronger signal than our automatic grab).
    composer.addEventListener("paste", function (ev) {
      if (!canCaptureImage) return;
      var items = (ev.clipboardData && ev.clipboardData.items) || [];
      for (var i = 0; i < items.length; i++) {
        if (String(items[i].type).indexOf("image/") !== 0) continue;
        var blob = items[i].getAsFile();
        if (!blob) continue;
        ev.preventDefault();
        imageFromBlob(blob).then(function (dataUrl) {
          if (!composer || !composer.isConnected || !dataUrl) return;
          shot = dataUrl;
          pending = false; // a pasted image ends the wait, whatever the capture is doing
          paintImageUi();
        });
        return;
      }
    });
    document.body.appendChild(composer);
    ta.focus({ preventScroll: true }); // preventScroll: the modal is fixed; focusing must not jump the page
    ok.onclick = function () {
      var note = ta.value.trim();
      if (!note) { ta.focus({ preventScroll: true }); return; }
      var pin = { note: note, kind: "change", anchor: anchor };
      // Overlay-LOCAL fields (never sent as-is): the raw image and the operator's opt-out. On submit
      // the image is uploaded out-of-band and only its URL lands on anchor.screenshotRef.
      if (shot && shotChk && shotChk.checked) pin.image = shot;
      pins.push(pin);
      closeComposer(); render();
    };
    cancel.onclick = closeComposer;
    hx.onclick = closeComposer;
    // Clicking the backdrop discards — but ONLY with nothing written. Throwing away a typed note on a
    // stray click outside is the one irreversible thing this dialog can do; it has to be deliberate.
    composer.onclick = function (ev) { if (ev.target === composer && !ta.value.trim()) closeComposer(); };
    composer.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") { ev.stopPropagation(); closeComposer(); return; }
      if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); ok.click(); return; }
      // Keep Tab inside the dialog — behind it sits a whole app whose links must not be reachable
      // while a modal is up (and Tab-ing into the page is how you lose the note you were writing).
      if (ev.key !== "Tab") return;
      var f = [ta, shotChk, ok, cancel, hx].filter(function (n) { return n && !n.disabled; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    });
  }
  function closeComposer() { if (composer) { composer.remove(); composer = null; } }

  function setPicking(on) {
    picking = on;
    if (on) { clearNotice(); minimized = false; cancelConfirm = false; }
    toggle.classList.toggle("on", on);
    document.body.style.cursor = on ? "crosshair" : "";
    if (!on) { hl.style.display = "none"; dragStart = null; dragging = false; }
    render();
  }

  function paintButton() {
    toggle.textContent = "";
    var ic = document.createElement("span");
    ic.className = "ah-ic"; ic.setAttribute("aria-hidden", "true");
    // Trusted literals (ours, named or default) go via innerHTML; host-supplied MARKUP is the
    // parse-vetted node, imported — never innerHTML.
    if (picking) ic.innerHTML = AH_STOP;
    else if (AH_NAMED_ICON) ic.innerHTML = AH_NAMED_ICON;
    else if (AH_ICON_NODE) ic.appendChild(document.importNode(AH_ICON_NODE, true));
    else ic.innerHTML = AH_ICON_DEFAULT;
    var lb = document.createElement("span");
    lb.textContent = (picking ? "Parar" : AH_LABEL) + (pins.length ? " (" + pins.length + ")" : "");
    toggle.appendChild(ic); toggle.appendChild(lb);
  }

  // The two tools, as LAYOUT MINIATURES rather than abstract glyphs: each little wireframe shows what
  // you END UP WITH — one element outlined, or a box drawn across several. That reads faster than a
  // cursor/marquee symbol, and it is the same picture in any language.
  var TOOLS = [
    {
      id: "select",
      label: "Selecionar",
      hint: "Clique no elemento que precisa de ajuste — ele fica realçado enquanto você passa o mouse.",
      art:
        '<svg width="46" height="30" viewBox="0 0 48 32" fill="none" aria-hidden="true">' +
        '<g fill="currentColor" opacity=".3"><rect x="4" y="4" width="26" height="4" rx="1"/>' +
        '<rect x="4" y="23" width="20" height="4" rx="1"/></g>' +
        '<rect x="2.5" y="11.5" width="41" height="9" rx="2" fill="none" stroke="var(--ah-accent)" stroke-width="2"/>' +
        '<path d="M30 17.5l7 7 .6-3 3-.6z" fill="var(--ah-accent)"/></svg>',
    },
    {
      id: "draw",
      label: "Desenhar",
      hint: "Arraste um quadrado sobre a área — o print sai exatamente do que você desenhar.",
      art:
        '<svg width="46" height="30" viewBox="0 0 48 32" fill="none" aria-hidden="true">' +
        '<g fill="currentColor" opacity=".3"><rect x="4" y="4" width="26" height="4" rx="1"/>' +
        '<rect x="4" y="14" width="38" height="4" rx="1"/><rect x="4" y="23" width="20" height="4" rx="1"/></g>' +
        '<rect x="7" y="6" width="33" height="21" fill="none" stroke="var(--ah-accent)" stroke-width="2" stroke-dasharray="4 3"/>' +
        '<rect x="37" y="24" width="6" height="6" rx="1" fill="var(--ah-accent)"/></svg>',
    },
  ];

  function renderTools(panel) {
    var row = document.createElement("div");
    row.className = "ah-tools";
    TOOLS.forEach(function (t) {
      var b = document.createElement("button");
      b.className = "ah-tool" + (tool === t.id ? " on" : "");
      b.type = "button";
      b.setAttribute("aria-pressed", tool === t.id ? "true" : "false");
      var art = document.createElement("span");
      art.innerHTML = t.art; // OUR literal — no host input reaches here
      var name = document.createElement("span");
      name.textContent = t.label;
      b.appendChild(art); b.appendChild(name);
      b.onclick = function () {
        if (tool === t.id) return;
        tool = t.id;
        hl.style.display = "none"; // a stale element outline from the other tool would lie
        dragStart = null; dragging = false;
        render();
      };
      row.appendChild(b);
    });
    panel.appendChild(row);
    var hint = document.createElement("div");
    hint.className = "ah-toolhint";
    hint.textContent = (TOOLS.filter(function (t) { return t.id === tool; })[0] || TOOLS[0]).hint;
    panel.appendChild(hint);
  }

  var lastStep = null; // which screen the LAST render painted — scroll is only worth keeping within one
  function render() {
    paintButton();
    // render() rebuilds the panel from scratch, so every click (picking a card, deleting an annotation)
    // used to bounce the scroll back to the top — taking the operator's own selection off screen.
    var prevScroll = panel ? panel.scrollTop : 0;
    var sameScreen = lastStep === step;
    if (panel) { panel.remove(); panel = null; }
    if (!pins.length && !picking) { minimized = false; cancelConfirm = false; step = "collect"; return; }

    // Minimized → a compact chip that keeps the pins out of the way; click to reopen.
    if (minimized) {
      panel = document.createElement("div"); panel.className = "ah-min"; panel.setAttribute("data-ah-ui", "1");
      panel.textContent = AH_LABEL + (pins.length ? " (" + pins.length + ")" : "") + " — abrir";
      panel.onclick = function () { minimized = false; render(); };
      document.body.appendChild(panel);
      return;
    }

    panel = document.createElement("div");
    panel.className = "ah-panel"; panel.setAttribute("data-ah-ui", "1");

    // Header: title + minimize + cancel — always available in the capture system.
    var head = document.createElement("div"); head.className = "ah-head";
    var htitle = document.createElement("span"); htitle.className = "ah-htitle";
    htitle.textContent = AH_LABEL + (pins.length ? " · " + pins.length : "");
    head.appendChild(htitle);
    var hacts = document.createElement("span"); hacts.className = "ah-hacts";
    var minb = document.createElement("button"); minb.className = "ah-hbtn"; minb.title = "Minimizar"; minb.setAttribute("aria-label", "Minimizar"); minb.textContent = "–";
    minb.onclick = function () { minimized = true; cancelConfirm = false; render(); };
    var clsb = document.createElement("button"); clsb.className = "ah-hbtn"; clsb.title = "Cancelar"; clsb.setAttribute("aria-label", "Cancelar"); clsb.textContent = "✕";
    clsb.onclick = function () { if (pins.length) { cancelConfirm = true; render(); } else { setPicking(false); } };
    hacts.appendChild(minb); hacts.appendChild(clsb); head.appendChild(hacts);
    panel.appendChild(head);

    // Cancel = discard ALL pins, WITH confirmation — supersedes the normal content.
    if (cancelConfirm) {
      var cc = document.createElement("div"); cc.className = "ah-warn";
      cc.textContent = "Descartar " + pins.length + " anotação(ões)? Não dá para desfazer.";
      panel.appendChild(cc);
      var crow = document.createElement("div"); crow.className = "ah-row";
      var yes = document.createElement("button"); yes.className = "ah-danger"; yes.textContent = "Descartar tudo";
      yes.onclick = function () { pins = []; cancelConfirm = false; minimized = false; step = "collect"; releaseDisplay(); setPicking(false); };
      var no = document.createElement("button"); no.className = "ah-cancel"; no.textContent = "Voltar";
      no.onclick = function () { cancelConfirm = false; render(); };
      crow.appendChild(yes); crow.appendChild(no); panel.appendChild(crow);
      document.body.appendChild(panel);
      return;
    }

    // Pre-warm the catalog while the operator is still marking, so screen 2 opens already populated.
    if (pins.length && destinationsEndpoint && catalogState === "idle") fetchCatalog();
    pickerEl = null;
    if (step === "send" && pins.length) renderSend(panel);
    else { step = "collect"; renderCollect(panel); }
    document.body.appendChild(panel);
    if (revealPicker && pickerEl) panel.scrollTop = Math.max(0, pickerEl.offsetTop - 44);
    else if (sameScreen) panel.scrollTop = prevScroll;
    revealPicker = false;
    lastStep = step;
  }

  // SCREEN 1 — what I marked. The marking mode is a VISIBLE state here (it stays armed between
  // captures), so the panel reads top-down as: the tool is on → these are the annotations → one way
  // forward. Exactly one primary action per state; the destination lives on the next screen.
  function renderCollect(panel) {
    if (picking) {
      var armed = document.createElement("div"); armed.className = "ah-armed";
      var dot = document.createElement("span"); dot.className = "ah-pulse";
      var txt = document.createElement("div");
      txt.appendChild(document.createTextNode("Marcação ativa "));
      var sub = document.createElement("span");
      sub.textContent = "— marque quantos ajustes quiser; ela só para quando você mandar.";
      txt.appendChild(sub);
      armed.appendChild(dot); armed.appendChild(txt);
      panel.appendChild(armed);
      renderTools(panel);
    }

    pins.forEach(function (p, i) {
      var d = document.createElement("div"); d.className = "ah-pin";
      var num = document.createElement("span"); num.className = "ah-num"; num.textContent = String(i + 1);
      var body = document.createElement("div"); body.className = "ah-pin-b";
      var n = document.createElement("div"); n.className = "n"; n.textContent = p.note;
      var c = document.createElement("div"); c.className = "ah-target"; c.textContent = targetLabel(p.anchor);
      body.appendChild(n); body.appendChild(c);
      // Content first, destroy last: the ✕ used to open the row, which put the only irreversible
      // control where the eye lands first.
      var x = document.createElement("button"); x.type = "button"; x.className = "ah-x";
      x.textContent = "✕"; x.title = "Remover"; x.setAttribute("aria-label", "Remover anotação " + (i + 1));
      x.onclick = function () { pins.splice(i, 1); render(); };
      d.appendChild(num); d.appendChild(body); d.appendChild(x);
      panel.appendChild(d);
    });

    // Only when the mode is OFF — armed, the whole page IS the button, and the strip above says so.
    if (!picking) {
      var add = document.createElement("button"); add.type = "button"; add.className = "ah-add";
      add.textContent = "＋  Marcar outro ajuste";
      add.onclick = function () { setPicking(true); };
      panel.appendChild(add);
    }

    if (pins.length) {
      var foot = document.createElement("div"); foot.className = "ah-foot";
      var go = document.createElement("button"); go.className = "ah-send";
      go.textContent = "Enviar " + pins.length + (pins.length === 1 ? " ajuste" : " ajustes") + "  →";
      // Choosing a destination is a decision the page must not interrupt: disarm on the way in.
      go.onclick = function () { step = "send"; setPicking(false); };
      foot.appendChild(go);
      panel.appendChild(foot);
    }
  }

  function batch() {
    // Project each pin to the WIRE shape — the local `image` (a multi-MB data URL) never rides in the
    // batch; by submit time its uploaded URL already sits on anchor.screenshotRef.
    var wire = pins.map(function (p) { return { note: p.note, kind: p.kind, anchor: p.anchor }; });
    return { v: 1, producer: producer, producedAt: new Date().toISOString(), link: resolveLink(), pins: wire };
  }
  // Mirrors the server's renderBatchMarkdown field-for-field so the "Copiar handoff" text matches
  // what actually lands on the card (kept in parity by hand — the static IIFE can't import the TS).
  // One line in, one line out — see the twin `inline()` in schema.ts for why a bullet cannot hold the
  // page's own line breaks.
  function mdInline(s) { return String(s).replace(/\s+/g, " ").trim(); }
  function mdTruncate(s, n) { return s.length > n ? s.slice(0, n) + "…" : s; }

  /**
   * Mirrors the server's renderPinMarkdown/renderBatchMarkdown (schema.ts). It has claimed to for a
   * while WITHOUT doing it — and every divergence became a bug the operator hit: the missing picture,
   * the raw multi-line `Texto` that ended the list early, "1 anotações", and the fields that simply
   * were not here (Tipo/Contêiner for a region, Cobre, bold labels). Kept in parity BY HAND, because
   * this static IIFE cannot import the TS — so a field added there must be added here, and the
   * markdown-parity test (schema.test.ts) fails until it is.
   */
  function pinMd(p, i) {
    var a = p.anchor;
    var lines = ["### " + (i + 1) + ". " + mdInline(p.note), ""];
    if (a.region) lines.push("- **Tipo:** região (área desenhada)");
    // Written as two whole literals rather than one concatenation so both labels are greppable in the
    // source — that is what lets the parity test SEE them (schema.test.ts).
    lines.push(a.region ? "- **Contêiner:** `" + a.selector + "`" : "- **Seletor:** `" + a.selector + "`");
    if (a.text) lines.push("- **Texto:** " + mdTruncate(mdInline(a.text), 120));
    if (a.covered && a.covered.length) {
      var items = a.covered.map(function (c) {
        return c.label ? mdTruncate(mdInline(c.label), 60) + " (`" + c.selector + "`)" : "`" + c.selector + "`";
      });
      lines.push("- **Cobre:** " + items.join(", "));
    }
    if (a.componentHint) lines.push("- **Componente:** " + mdInline(a.componentHint));
    var where = [a.route || a.url, a.viewport ? a.viewport.w + "×" + a.viewport.h : null].filter(Boolean).join(" · ");
    if (where) lines.push("- **Onde:** " + where);
    if (a.rect) {
      lines.push("- **Posição:** " + Math.round(a.rect.x) + "," + Math.round(a.rect.y) + " · " + Math.round(a.rect.w) + "×" + Math.round(a.rect.h));
    }
    // ABSOLUTE url, unlike the server's: the card is rendered ON this origin, but the handoff is
    // pasted somewhere ELSE, where a same-origin path resolves against the wrong host — or nothing.
    if (a.screenshotRef) {
      var ref = a.screenshotRef.indexOf("/") === 0 ? location.origin + a.screenshotRef : a.screenshotRef;
      lines.push("", "![Captura da região](" + ref + ")");
    }
    return lines.join("\n");
  }
  function handoffMd() {
    var n = pins.length;
    var head = "## Feedback visual (" + n + " " + (n === 1 ? "anotação" : "anotações") + ")";
    return [head].concat(pins.map(pinMd)).join("\n\n"); // join já separa — ver o par em schema.ts
  }
  /**
   * Copy the handoff — uploading any pending image FIRST. The image lives locally as a data URL until
   * submit uploads it, so a handoff copied before sending simply had no picture to point at: the
   * operator pasted the text and the screenshot was silently missing. Copy now does the same upload
   * the send does, so both paths produce the same markdown.
   */
  function copyHandoff() {
    if (!navigator.clipboard) { flash("Clipboard indisponível."); return; }
    var pending = pins.filter(function (p) { return p.image && !(p.anchor && p.anchor.screenshotRef); });
    if (!pending.length) return writeHandoff();
    flash("Subindo a imagem para o handoff…");
    Promise.all(pending.map(function (p) {
      return uploadShot(p.image).then(function (url) { if (url) p.anchor.screenshotRef = url; });
    })).then(writeHandoff, writeHandoff); // an upload that fails must not cost the operator the text
  }
  function writeHandoff() {
    var withShot = pins.filter(function (p) { return p.anchor && p.anchor.screenshotRef; }).length;
    var missing = pins.filter(function (p) { return p.image && !(p.anchor && p.anchor.screenshotRef); }).length;
    navigator.clipboard.writeText(handoffMd()).then(function () {
      flash(missing ? "Handoff copiado — imagem falhou ao subir." : withShot ? "Handoff copiado (com a imagem)." : "Handoff copiado.");
    });
  }

  function submit() {
    if (!pins.length) return;
    if ((mode === "card" && !sel.card) || (mode === "session" && !sel.session)) { flash("Escolha um destino."); return; }
    // Images first, OUT-OF-BAND: each kept image is uploaded and its same-origin URL stamped onto the
    // pin's anchor (screenshotRef). An upload that fails just leaves the pin image-less — the
    // annotation itself must never be lost over a picture.
    var pending = pins.filter(function (p) { return p.image; });
    flash(pending.length ? "Enviando imagem…" : "Enviando…");
    Promise.all(pending.map(function (p) {
      return uploadShot(p.image).then(function (url) { if (url) p.anchor.screenshotRef = url; });
    }))
      .then(function () {
        // In EMBED mode the nonce travels as a custom header — which also forces a CORS preflight the
        // board answers only for an allowlisted origin. `credentials: omit`: the nonce IS the
        // credential; we never want the operator's board session riding along cross-origin.
        var h = { "content-type": "application/json" };
        if (nonce) h["x-ah-nonce"] = nonce;
        return fetch(endpoint, {
          method: "POST",
          headers: h,
          credentials: embedMode ? "omit" : "same-origin",
          body: JSON.stringify(batch()),
        });
      })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: "resposta inválida (" + r.status + ")" }; }); })
      .then(function (j) {
        if (j && j.ok) {
          // The feedback session is over — stop sharing (the browser's own capture indicator goes
          // away with it). The next batch asks again, which is the honest lifetime for the permission.
          pins = []; step = "collect"; releaseDisplay(); setPicking(false); confirmSent(j.result);
        } else {
          flash("Falhou: " + ((j && (j.error || (j.result && j.result.detail))) || "erro"));
        }
      })
      .catch(function (e) { flash("Erro de rede: " + e.message); });
  }

  function flash(msg) {
    var f = document.createElement("div"); f.setAttribute("data-ah-ui", "1");
    f.style.cssText = "position:fixed;left:50%;bottom:72px;transform:translateX(-50%);z-index:2147483647;background:var(--ah-fg);color:var(--ah-surface);padding:8px 14px;border-radius:8px;font:13px var(--ah-font);box-shadow:0 8px 30px rgba(15,15,15,.25)";
    f.textContent = msg; document.body.appendChild(f);
    setTimeout(function () { f.remove(); }, 2600);
  }

  var noticeEl = null;
  function clearNotice() { if (noticeEl) { noticeEl.remove(); noticeEl = null; } }
  function cardUrlFor(result) {
    if (!result || !result.cardId || !cardUrlTemplate) return "";
    return cardUrlTemplate
      .replace("{board}", encodeURIComponent(link.board || ""))
      .replace("{id}", encodeURIComponent(result.cardId));
  }
  // Persistent, dismissable confirmation — reflects the sink that ACTUALLY ran (result.detail, which
  // already distinguishes e.g. refine vs refine->triage) with a link to the created/updated item when
  // the host supplied a cardUrlTemplate. Replaces the 2.6s flash that made a real board mutation look
  // like a mystery blip.
  function confirmSent(result) {
    clearNotice();
    noticeEl = document.createElement("div");
    noticeEl.className = "ah-notice"; noticeEl.setAttribute("data-ah-ui", "1");
    var close = document.createElement("span"); close.className = "close"; close.textContent = "✕"; close.onclick = clearNotice;
    noticeEl.appendChild(close);
    var msg = document.createElement("div");
    msg.textContent = "✓ " + ((result && result.detail) || "Feedback enviado.");
    noticeEl.appendChild(msg);
    var url = cardUrlFor(result);
    if (url) {
      var w = document.createElement("div"); w.style.marginTop = "6px";
      var a = document.createElement("a"); a.href = url; a.textContent = "Abrir " + (result.cardId || "item") + " →";
      w.appendChild(a); noticeEl.appendChild(w);
    } else if (result && result.cardId) {
      var idl = document.createElement("div");
      idl.style.cssText = "margin-top:4px;color:var(--ah-fg-muted);font:11px var(--ah-mono)";
      idl.textContent = result.cardId; noticeEl.appendChild(idl);
    }
    document.body.appendChild(noticeEl);
  }

  toggle.onclick = function () { setPicking(!picking); };
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("click", onClick, true);
  render();
})();
