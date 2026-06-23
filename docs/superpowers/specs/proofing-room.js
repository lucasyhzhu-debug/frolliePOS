/* ============================================================================
 * proofing-room.js — drop-in comment + extract wrapper for ANY html page.
 *
 * Usage: add  <script src="/proofing-room.js"></script>  to any page.
 * Reviewers add comments anywhere; comments persist in localStorage per page
 * path so a reload doesn't lose them. Format-agnostic: works on landing pages,
 * standalone html, and slide decks.
 *
 * v2 (2026-06-12): right-docked panel, expandable comments tray with the full
 * list + jump-to, SapphireOS sapphire + ClimatePulse plum styling, and a thick
 * plum page border signalling proofing mode.
 *
 * v3 (2026-06-13, EM Studio v1.1 §6 D2): runs INSIDE each slide iframe and is now
 * a LIVE BRIDGE, not just a manual extract. Two additions:
 *   1. window.__PROOFING_CONFIG (set by the render route before this script):
 *      { accent?, accentDeep?, tint?, slideOrder? } — brand-skins the chrome
 *      from the workspace palette and stamps slideOrder onto every comment so
 *      the host can address the right Convex slide.
 *   2. On every comment add / edit / delete, postMessage the full comment set to
 *      the parent host (type "proofing-room:comments") — the host calls
 *      api.comments.ingestProofingComments so comments land in Convex reactively
 *      and re-anchor on reload. Manual "Extract JSON" remains as a fallback.
 *
 * Downloaded JSON:
 * { tool, version, url, title, path, extractedAt, reviewers[],
 *   comments[ {id,author,text,createdAt,anchorText,section,selector,tag,slideOrder} ],
 *   document[ {tag,text,selector,comments[{author,text}]} ] }
 * ========================================================================== */
(function () {
  "use strict";
  if (window.__proofingRoom) return;

  /* ---- host config (brand chrome + slideOrder), injected by render route ---- */
  var CFG = (window.__PROOFING_CONFIG && typeof window.__PROOFING_CONFIG === "object")
    ? window.__PROOFING_CONFIG
    : {};
  var SLIDE_ORDER = (typeof CFG.slideOrder === "number" && isFinite(CFG.slideOrder))
    ? CFG.slideOrder
    : null;
  // FEATURE 1 — direct-edit capture. editOnly = copy-only editor (no commenting
  // chrome). SERVER_OVERRIDES = the authoritative stored override set this doc
  // seeds from (data-safety: server is source of truth, never an empty echo).
  var EDIT_ONLY = CFG.editOnly === true;
  var SERVER_OVERRIDES = Array.isArray(CFG.overrides) ? CFG.overrides : null;

  var KEY = "proofing-room:" + location.pathname;
  var state = {
    reviewer: localStorage.getItem("proofing-room:reviewer") || "",
    commenting: false,
    editing: false,
    open: true,
    comments: [],
    edits: [],
    seq: 0,
    sendRound: 0,
  };
  try {
    var saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (Array.isArray(saved.comments)) state.comments = saved.comments;
    if (Array.isArray(saved.edits)) state.edits = saved.edits;
    if (typeof saved.seq === "number") state.seq = saved.seq;
    if (typeof saved.sendRound === "number") state.sendRound = saved.sendRound;
  } catch (e) {}
  // FEATURE 1 — editOnly is a pure copy editor: never surface restored comments
  // (the theatre owns commenting via its own host-DOM composer), so they can't
  // double up with the host UI or echo an empty comment set on persist.
  if (EDIT_ONLY) state.comments = [];

  function persist() {
    localStorage.setItem(
      KEY,
      JSON.stringify({ comments: state.comments, edits: state.edits, seq: state.seq, sendRound: state.sendRound })
    );
    bridge();
  }

  /* ---- live bridge: postMessage the current comment set to the parent host -
   * Shape matches api.comments.ingestProofingComments
   * ({comments:[{selector,anchorText,section,text,slideOrder}]}). slideOrder is
   * stamped from the host config so the comment lands on the right slide; the
   * host de-dupes by clientId so a re-post (after edit/reload) is idempotent.
   * Best-effort + debounced so rapid edits don't flood the parent. */
  // Comments touched (created or edited) during THIS page session. Only these
  // cross the bridge — pre-existing localStorage comments were already ingested
  // into Convex, so re-posting them on a later edit would duplicate rows.
  var touched = {};
  function markTouched(id) { if (id) touched[id] = true; }
  // FEATURE 1 — only a genuine user edit (not the server seed on boot) may cross
  // the edits bridge, so a partial/empty seed can never echo back and clobber the
  // stored override set through the host's full-replace.
  var editsDirty = false;

  var bridgeTimer = null;
  function bridge() {
    if (window.parent === window) return; // standalone page → no host to bridge to
    if (bridgeTimer) clearTimeout(bridgeTimer);
    bridgeTimer = setTimeout(function () {
      bridgeTimer = null;
      try {
        var payload = {
          comments: state.comments
            .filter(function (c) { return touched[c.id]; })
            .map(function (c) {
            return {
              clientId: c.id,
              selector: c.selector,
              anchorText: c.anchorText,
              section: c.section,
              text: c.text,
              slideOrder: SLIDE_ORDER === null ? undefined : SLIDE_ORDER,
            };
          }),
        };
        window.parent.postMessage(
          { type: "proofing-room:comments", slideOrder: SLIDE_ORDER, payload: payload },
          "*"
        );
      } catch (e) {}
      // FEATURE 1 — direct-edit capture bridge. Send the FULL current edit set
      // (one slide; small) so the host can do a data-safe FULL replace of
      // content_overrides. persist() (called by upsertEdit/removeEdit) drives this,
      // so edits auto-bridge with the same 220ms debounce as comments.
      if (editsDirty) {
        try {
          window.parent.postMessage(
            {
              type: "proofing-room:edits",
              slideOrder: SLIDE_ORDER,
              payload: {
                slideOrder: SLIDE_ORDER,
                edits: state.edits.map(function (e) {
                  return { selector: e.selector, text: e.text };
                }),
              },
            },
            "*"
          );
        } catch (e) {}
      }
    }, 220);
  }

  /* ---- element helpers ---------------------------------------------------- */
  function isUi(el) {
    return !!(el.closest && el.closest("#pr-root, #pr-pins, #pr-pop, #pr-border, #pr-badge"));
  }
  function selectorFor(el) {
    if (!el || el === document.body) return "body";
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body && parts.length < 8) {
      var tag = el.tagName.toLowerCase();
      if (el.id) {
        parts.unshift(tag + "#" + CSS.escape(el.id));
        break;
      }
      var i = 1, sib = el;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === el.tagName) i++;
      parts.unshift(tag + ":nth-of-type(" + i + ")");
      el = el.parentElement;
    }
    return parts.join(" > ");
  }
  function snippet(el, max) {
    var t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    max = max || 140;
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
  }
  function nearestSection(el) {
    var cur = el;
    while (cur && cur !== document.body) {
      var sib = cur;
      while (sib) {
        if (/^H[1-6]$/.test(sib.tagName || "")) return snippet(sib, 80);
        sib = sib.previousElementSibling;
      }
      cur = cur.parentElement;
    }
    var h = document.querySelector("h1");
    return h ? snippet(h, 80) : document.title;
  }

  /* ---- styles (brand-parameterised; defaults = SapphireOS + ClimatePulse) -
   * SAPPHIRE = the action accent (add-comment, focus rings) ← workspace accent.
   * PLUM = the proofing chrome (border, badge, pins) ← workspace accentDeep, or a
   * derived deeper tone of the accent when only one colour is supplied. */
  function isHex(s) { return typeof s === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s); }
  var SAPPHIRE = isHex(CFG.accent) ? CFG.accent : "#306FA8";
  var SAPPHIRE_DEEP = isHex(CFG.accentDeep) ? CFG.accentDeep : "#1E4C80";
  var PLUM = isHex(CFG.accentDeep) ? CFG.accentDeep : "#3D1F3D";
  var PLUM_MID = "#6B4A6B", PLUM_TINT = isHex(CFG.tint) ? CFG.tint : "#F5EEF5";
  var css =
    "#pr-root,#pr-pop,#pr-badge{font-family:ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif}" +
    /* thick proofing-mode page border + badge */
    "#pr-border{position:fixed;inset:0;border:7px solid " + PLUM + ";pointer-events:none;z-index:2147481000}" +
    "#pr-badge{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147481500;" +
    "background:" + PLUM + ";color:#fff;font-size:10px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;" +
    "padding:5px 16px;border-radius:0 0 9px 9px;box-shadow:0 2px 10px rgba(61,31,61,.4)}" +
    "#pr-badge .d{display:inline-block;width:6px;height:6px;border-radius:50%;background:#e7b6e7;margin-right:7px;vertical-align:middle}" +
    /* right-docked panel */
    "#pr-root{position:fixed;right:14px;top:84px;z-index:2147483000;width:326px;max-height:calc(100vh - 104px);" +
    "display:flex;flex-direction:column;background:#fff;color:" + PLUM + ";border:1px solid #e6dbe6;" +
    "border-radius:14px;box-shadow:0 18px 50px rgba(61,31,61,.28);overflow:hidden}" +
    "#pr-root *{box-sizing:border-box}" +
    "#pr-hd{display:flex;align-items:center;gap:9px;padding:12px 14px;background:" + PLUM + ";color:#fff;cursor:pointer;" +
    "font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;font-weight:800}" +
    "#pr-hd .d{width:8px;height:8px;border-radius:50%;background:#e7b6e7}" +
    "#pr-hd .cnt{margin-left:auto;background:rgba(255,255,255,.18);border-radius:99px;padding:2px 9px;font-size:11px;letter-spacing:0}" +
    "#pr-hd .chev{transition:transform .18s ease;opacity:.85}#pr-root.collapsed #pr-hd .chev{transform:rotate(-90deg)}" +
    "#pr-controls{padding:13px 14px;display:flex;flex-direction:column;gap:10px;border-bottom:1px solid #efe6ef}" +
    "#pr-controls label{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:" + PLUM_MID + ";display:block;margin-bottom:4px}" +
    "#pr-name{width:100%;border:1px solid #ddcedd;color:" + PLUM + ";border-radius:8px;padding:8px 10px;font-size:13px}" +
    "#pr-name:focus{outline:none;border-color:" + SAPPHIRE + ";box-shadow:0 0 0 3px rgba(48,111,168,.18)}" +
    "#pr-btns{display:flex;gap:8px}.pr-b{flex:1;border:none;border-radius:8px;padding:9px 10px;font-size:12.5px;font-weight:700;cursor:pointer}" +
    ".pr-b.add{background:" + SAPPHIRE + ";color:#fff}.pr-b.add:hover{background:" + SAPPHIRE_DEEP + "}" +
    ".pr-b.add.active{background:" + PLUM + "}" +
    ".pr-b.ex{background:" + PLUM + ";color:#fff}.pr-b.ex:hover{background:" + PLUM_MID + "}" +
    ".pr-b.gh{background:" + PLUM_TINT + ";color:" + PLUM_MID + "}.pr-b.gh:hover{background:#ecdfec}" +
    ".pr-b.edit{background:#EEF4FA;color:" + SAPPHIRE_DEEP + "}.pr-b.edit:hover{background:#dbe8f3}.pr-b.edit.active{background:" + SAPPHIRE + ";color:#fff}" +
    '[contenteditable="true"].pr-editing-el{outline:2px solid ' + SAPPHIRE + "!important;outline-offset:2px;background:rgba(48,111,168,.06)!important}" +
    /* OUTLINE GATE (FEATURE 1): the dashed box only shows while edit mode is
     * ACTIVE (body.pr-editing). On a read load or when edit is toggled off, the
     * edited TEXT stays applied but the permanent dashed outline is suppressed. */
    "body.pr-editing .pr-edited{outline:1.5px dashed " + PLUM_MID + "!important;outline-offset:2px}" +
    ".pr-row.edit{border-left-color:" + SAPPHIRE + "}.pr-row.edit .pn{background:" + SAPPHIRE + "}.pr-row .was{margin-top:5px;font-size:11px;color:" + PLUM_MID + ";text-decoration:line-through}" +
    "#pr-list{overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:8px;background:#fbf7fb}" +
    "#pr-root.collapsed #pr-list,#pr-root.collapsed #pr-controls{display:none}" +
    "#pr-empty{padding:18px 10px;text-align:center;font-size:12px;color:" + PLUM_MID + "}" +
    ".pr-row{background:#fff;border:1px solid #efe6ef;border-left:3px solid " + PLUM + ";border-radius:9px;padding:10px 11px;cursor:pointer;transition:box-shadow .15s ease}" +
    ".pr-row:hover{box-shadow:0 4px 14px rgba(61,31,61,.12)}" +
    ".pr-row .top{display:flex;align-items:center;gap:8px;margin-bottom:5px}" +
    ".pr-row .pn{width:20px;height:20px;border-radius:50%;background:" + PLUM + ";color:#fff;font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center;flex:none}" +
    ".pr-row .who{font-size:11px;font-weight:700;color:" + PLUM + "}" +
    ".pr-row .del{margin-left:auto;color:#b08bb0;font-size:15px;line-height:1;background:none;border:none;cursor:pointer;padding:0 2px}" +
    ".pr-row .del:hover{color:#9a2e26}" +
    ".pr-row .txt{font-size:12.5px;line-height:1.45;color:#2a1a2a}" +
    ".pr-row .anchor{margin-top:6px;font-size:10px;color:" + PLUM_MID + ";letter-spacing:.02em;line-height:1.4}" +
    ".pr-row .anchor b{color:" + SAPPHIRE_DEEP + ";font-weight:700}" +
    "body.pr-commenting *{cursor:crosshair!important}" +
    ".pr-hl{outline:2px dashed " + SAPPHIRE + "!important;outline-offset:1px!important}" +
    ".pr-flash{animation:prflash 1.4s ease}@keyframes prflash{0%,100%{box-shadow:0 0 0 0 rgba(61,31,61,0)}30%{box-shadow:0 0 0 4px rgba(61,31,61,.45)}}" +
    "#pr-pins{position:absolute;top:0;left:0;width:0;height:0;z-index:2147482000}" +
    ".pr-pin{position:absolute;width:24px;height:24px;border-radius:50%;background:" + PLUM + ";color:#fff;font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 9px rgba(61,31,61,.45);cursor:pointer;transform:translate(-50%,-50%);border:2px solid #fff}" +
    ".pr-pin:hover{background:" + PLUM_MID + "}" +
    "#pr-pop{position:absolute;z-index:2147483600;width:248px;background:#fff;color:" + PLUM + ";border-radius:11px;box-shadow:0 14px 40px rgba(61,31,61,.3);border:1px solid #e6dbe6;padding:13px}" +
    "#pr-pop textarea{width:100%;height:74px;border:1px solid #ddcedd;border-radius:8px;padding:8px;font:inherit;font-size:13px;resize:vertical;color:" + PLUM + "}" +
    "#pr-pop textarea:focus{outline:none;border-color:" + SAPPHIRE + "}" +
    "#pr-pop .meta{font-size:10.5px;color:" + PLUM_MID + ";margin:0 0 8px;line-height:1.4}" +
    "#pr-pop .meta b{color:" + SAPPHIRE_DEEP + "}" +
    "#pr-pop .row{display:flex;gap:8px;margin-top:9px}" +
    "#pr-pop button{flex:1;border:none;border-radius:8px;padding:8px;font-size:12.5px;font-weight:700;cursor:pointer}" +
    "#pr-pop .save{background:" + SAPPHIRE + ";color:#fff}#pr-pop .del{background:#f4e3ec;color:#9a2e26}#pr-pop .cancel{background:" + PLUM_TINT + ";color:" + PLUM_MID + "}" +
    /* Send-to-Claude button + per-round sent state */
    ".pr-b.send{background:linear-gradient(135deg," + SAPPHIRE + "," + SAPPHIRE_DEEP + ");color:#fff}.pr-b.send:hover{filter:brightness(1.08)}" +
    ".pr-row.sent{opacity:.5}" +
    ".pr-row .stag{margin-left:6px;font-size:9px;font-weight:800;letter-spacing:.04em;color:#fff;background:" + PLUM_MID + ";border-radius:99px;padding:1px 6px;text-transform:uppercase}" +
    ".pr-pin.sent{background:#8a7a8a;opacity:.55}" +
    "#pr-toast{position:fixed;right:16px;bottom:16px;z-index:2147483700;max-width:320px;background:#fff;color:" + PLUM + ";border:1px solid #e6dbe6;border-radius:11px;padding:12px 14px;font-size:12.5px;line-height:1.45;box-shadow:0 14px 40px rgba(61,31,61,.3);display:none}#pr-toast b{color:" + SAPPHIRE_DEEP + "}";

  var styleEl = document.createElement("style");
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  /* ---- chrome: border, badge, panel, pins --------------------------------- */
  var border = document.createElement("div");
  border.id = "pr-border";
  document.body.appendChild(border);
  var badge = document.createElement("div");
  badge.id = "pr-badge";
  badge.innerHTML = '<span class="d"></span>Proofing mode';
  document.body.appendChild(badge);

  var root = document.createElement("div");
  root.id = "pr-root";
  root.innerHTML =
    '<div id="pr-hd"><span class="d"></span>Proofing room<span class="cnt" id="pr-cnt">0</span>' +
    '<span class="chev">▾</span></div>' +
    '<div id="pr-controls">' +
    '<div><label>Reviewer</label><input id="pr-name" placeholder="Your name" autocomplete="off" /></div>' +
    '<div id="pr-btns"><button class="pr-b add" id="pr-add">+ Comment</button>' +
    '<button class="pr-b edit" id="pr-edit">✎ Edit text</button></div>' +
    '<button class="pr-b ex" id="pr-ex">Extract JSON</button>' +
    '<button class="pr-b gh" id="pr-clear">Clear all</button>' +
    "</div>" +
    '<div id="pr-list"></div>';
  document.body.appendChild(root);

  var pins = document.createElement("div");
  pins.id = "pr-pins";
  document.body.appendChild(pins);

  var nameInput = root.querySelector("#pr-name");
  nameInput.value = state.reviewer;
  nameInput.addEventListener("input", function () {
    state.reviewer = nameInput.value.trim();
    localStorage.setItem("proofing-room:reviewer", state.reviewer);
  });

  /* draggable panel: drag the header to move; a clean click still collapses.
   * Lets reviewers shove the panel aside to reach elements underneath it. */
  (function () {
    var hd = root.querySelector("#pr-hd");
    hd.style.cursor = "move";
    var dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
    hd.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      var r = root.getBoundingClientRect();
      ox = r.left; oy = r.top;
      root.style.right = "auto"; root.style.left = ox + "px"; root.style.top = oy + "px";
      e.preventDefault();
    });
    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      var nx = Math.min(Math.max(4, ox + dx), window.innerWidth - root.offsetWidth - 4);
      var ny = Math.min(Math.max(4, oy + dy), window.innerHeight - 44);
      root.style.left = nx + "px"; root.style.top = ny + "px";
    });
    document.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false;
      if (!moved) { state.open = !state.open; root.classList.toggle("collapsed", !state.open); }
    });
  })();
  var addBtn = root.querySelector("#pr-add");
  var editBtn = root.querySelector("#pr-edit");
  addBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    setCommenting(!state.commenting);
  });
  editBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    setEditing(!state.editing);
  });
  root.querySelector("#pr-ex").addEventListener("click", function (e) {
    e.stopPropagation();
    extract();
  });
  root.querySelector("#pr-clear").addEventListener("click", function (e) {
    e.stopPropagation();
    if (!state.comments.length || confirm("Clear all comments on this page?")) {
      state.comments = [];
      persist();
      render();
    }
  });

  /* ---- Send to Claude: export only the NEW (unsent) round, then grey them ---
   * Config via window.__PROOFING_CONFIG: { sendPrefix, specPath }. Each click
   * downloads a round JSON of unsent comments+edits, copies a ready prompt, and
   * marks those items sent (greyed in the tray). New notes form the next round. */
  var SEND_PREFIX = (typeof CFG.sendPrefix === "string" && CFG.sendPrefix)
    ? CFG.sendPrefix
    : ("proofing-" + (location.pathname.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "page") + "-");
  var SPEC_PATH = (typeof CFG.specPath === "string" && CFG.specPath) ? CFG.specPath : "the related design spec";
  var toastEl = document.createElement("div");
  toastEl.id = "pr-toast";
  document.body.appendChild(toastEl);
  function showToast(html) {
    toastEl.innerHTML = html; toastEl.style.display = "block";
    clearTimeout(toastEl._h); toastEl._h = setTimeout(function () { toastEl.style.display = "none"; }, 11000);
  }
  var sendBtn = document.createElement("button");
  sendBtn.id = "pr-send"; sendBtn.className = "pr-b send"; sendBtn.textContent = "📤 Send comments to Claude";
  root.querySelector("#pr-controls").appendChild(sendBtn);
  sendBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    var newC = state.comments.filter(function (c) { return !c.sent; });
    var newE = state.edits.filter(function (x) { return !x.sent; });
    var n = newC.length + newE.length;
    if (!n) { showToast("Nothing new to send — every note is already sent. Add more comments, then send the next round."); return; }
    state.sendRound = (state.sendRound || 0) + 1;
    var round = state.sendRound;
    var fname = SEND_PREFIX + "r" + round + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
    var data = {
      tool: "proofing-room", round: round, url: location.href, title: document.title,
      extractedAt: new Date().toISOString(), comments: newC, edits: newE,
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    var prompt = "I left " + n + " NEW proofing notes (round " + round + ") on the mockups. Read my newest export — the latest file matching " + SEND_PREFIX + "*.json in my Downloads folder (" + fname + "). IMPORTANT: treat each comment/edit as a real DESIGN/SPEC change request, not just a visual tweak — many imply changes to the data model, flows, business rules, or behaviour. For every note: (1) update the HTML mockup, AND (2) update the written spec (" + SPEC_PATH + ") to match. If a note is ambiguous about scope, ask before assuming it's visual-only.";
    function done(ok) {
      showToast("✅ Sent round " + round + " (" + n + " notes) — downloaded <b>" + fname + "</b>" +
        (ok ? " + copied the prompt." : ".") + "<br>Switch to Claude and " +
        (ok ? "paste (Ctrl+V) + send." : "ask me to read the latest " + SEND_PREFIX + "*.json in Downloads."));
    }
    newC.forEach(function (c) { c.sent = true; c.round = round; });
    newE.forEach(function (x) { x.sent = true; x.round = round; });
    persist(); render();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(prompt).then(function () { done(true); }, function () { done(false); });
    } else { done(false); }
  });

  // FEATURE 1 — editOnly: strip the commenting chrome so the surface is a pure
  // copy editor. Hide the "+ Comment" affordance, the Extract/Clear comment
  // controls, the plum proofing border + badge (they read as comment mode), and
  // never surface the comment list/composer. The in-place "Edit text" editor and
  // the Done/finish toggle stay. Auto-enter text-edit mode below (after setEditing
  // is defined).
  if (EDIT_ONLY) {
    addBtn.style.display = "none";
    var exBtn = root.querySelector("#pr-ex");
    var clearBtn = root.querySelector("#pr-clear");
    if (exBtn) exBtn.style.display = "none";
    if (clearBtn) clearBtn.style.display = "none";
    if (border) border.style.display = "none";
    if (badge) badge.style.display = "none";
  }

  function setCommenting(on) {
    if (on && state.editing) setEditing(false);
    state.commenting = on;
    document.body.classList.toggle("pr-commenting", on);
    addBtn.classList.toggle("active", on);
    addBtn.textContent = on ? "Click an element… (Esc)" : "+ Comment";
  }
  function setEditing(on) {
    if (on && state.commenting) setCommenting(false);
    state.editing = on;
    document.body.classList.toggle("pr-editing", on);
    editBtn.classList.toggle("active", on);
    editBtn.textContent = on ? "Editing… (Esc)" : "✎ Edit text";
  }

  /* ---- inline text editing ------------------------------------------------ */
  function isEditable(el) {
    if (!el || isUi(el)) return false;
    var t = el.tagName;
    if (/^(P|H[1-6]|LI|BLOCKQUOTE|FIGCAPTION|SPAN|A|BUTTON|TD|TH|DT|DD|EM|STRONG|CITE|SMALL|LABEL)$/.test(t))
      return (el.innerText || "").trim().length > 0;
    if (t === "DIV" && el.children.length === 0 && (el.innerText || "").trim()) return true;
    return false;
  }
  function upsertEdit(el, orig, now) {
    var s = selectorFor(el);
    var ex = state.edits.filter(function (x) { return x.selector === s; })[0];
    if (ex) {
      ex.text = now;
      ex.author = state.reviewer || ex.author || "anon";
    } else {
      state.seq++;
      state.edits.push({
        id: "e" + state.seq, kind: "edit", author: state.reviewer || "anon",
        original: orig, text: now, createdAt: new Date().toISOString(),
        section: nearestSection(el), selector: s, tag: el.tagName.toLowerCase(),
      });
    }
    editsDirty = true;
    persist();
    render();
  }
  function removeEditBySelector(s) {
    var n = state.edits.length;
    state.edits = state.edits.filter(function (x) { return x.selector !== s; });
    if (state.edits.length !== n) { editsDirty = true; persist(); render(); }
  }
  function removeEdit(id) {
    var e = state.edits.filter(function (x) { return x.id === id; })[0];
    if (e) {
      var el = locate(e);
      if (el) { el.textContent = e.original; el.classList.remove("pr-edited"); el.removeAttribute("data-pr-orig"); }
    }
    state.edits = state.edits.filter(function (x) { return x.id !== id; });
    editsDirty = true;
    persist();
    render();
  }
  function applyEdits() {
    state.edits.forEach(function (e) {
      var el = locate(e);
      if (!el) return;
      if (el.getAttribute("data-pr-orig") === null) el.setAttribute("data-pr-orig", e.original);
      if ((el.innerText || "").trim() !== e.text) el.textContent = e.text;
      el.classList.add("pr-edited");
    });
  }
  // FEATURE 1 — seed state.edits from the SERVER override set (data-safety fix).
  // In the (proof && edit) capture flow the route does NOT pre-apply the overlay,
  // so el.textContent is the TRUE original. We capture that original, apply the
  // stored text, and REPLACE state.edits with the server-authoritative set — so
  // the first bridge() post echoes the server's own data rather than an empty
  // (or stale-localStorage) set that would wipe pre-existing overrides. persist()
  // once after seeding; the bottom-of-file boot intentionally does not bridge.
  function seedFromServer() {
    if (!SERVER_OVERRIDES) return;
    var seeded = [];
    SERVER_OVERRIDES.forEach(function (ov) {
      if (!ov || typeof ov.selector !== "string" || typeof ov.text !== "string") return;
      var el;
      try {
        el = document.querySelector(ov.selector);
      } catch (e) {
        el = null;
      }
      state.seq++;
      if (el) {
        var original = el.textContent;
        el.textContent = ov.text;
        el.setAttribute("data-pr-orig", original);
        el.classList.add("pr-edited");
        seeded.push({
          id: "e" + state.seq,
          kind: "edit",
          author: state.reviewer || "anon",
          original: original,
          text: ov.text,
          createdAt: new Date().toISOString(),
          section: nearestSection(el),
          selector: ov.selector,
          tag: el.tagName.toLowerCase(),
        });
      } else {
        // Node not in THIS render (e.g. a structurally-changed / revised slide).
        // KEEP the override in the set — never drop it — so the host's full
        // replace can't DELETE a stored override that the serve-time overlay
        // would otherwise re-apply when the node returns. Just skip the DOM.
        seeded.push({
          id: "e" + state.seq,
          kind: "edit",
          author: state.reviewer || "anon",
          original: ov.text,
          text: ov.text,
          createdAt: new Date().toISOString(),
          section: "",
          selector: ov.selector,
          tag: "",
          unresolved: true,
        });
      }
    });
    state.edits = seeded; // server is the source of truth (matched + unmatched)
    persist();
  }

  document.addEventListener("click", function (e) {
    if (!state.editing || isUi(e.target) || !isEditable(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    if (el.getAttribute("data-pr-orig") === null)
      el.setAttribute("data-pr-orig", (el.innerText || "").trim());
    el.setAttribute("contenteditable", "true");
    el.classList.add("pr-editing-el");
    el.focus();
  }, true);
  document.addEventListener("blur", function (e) {
    var el = e.target;
    if (!el || !el.getAttribute || el.getAttribute("contenteditable") !== "true") return;
    if (el.getAttribute("data-pr-orig") === null) return;
    el.removeAttribute("contenteditable");
    el.classList.remove("pr-editing-el");
    var orig = el.getAttribute("data-pr-orig");
    var now = (el.innerText || "").trim();
    if (now !== orig) { upsertEdit(el, orig, now); el.classList.add("pr-edited"); }
    else { removeEditBySelector(selectorFor(el)); el.classList.remove("pr-edited"); el.removeAttribute("data-pr-orig"); }
  }, true);

  /* ---- comment capture ---------------------------------------------------- */
  var hoverEl = null;
  document.addEventListener(
    "mouseover",
    function (e) {
      if (!state.commenting || isUi(e.target)) return;
      if (hoverEl) hoverEl.classList.remove("pr-hl");
      hoverEl = e.target;
      hoverEl.classList.add("pr-hl");
    },
    true
  );
  document.addEventListener(
    "click",
    function (e) {
      if (!state.commenting || isUi(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (hoverEl) hoverEl.classList.remove("pr-hl");
      openPopover(e.target, e.clientX, e.clientY, null);
      setCommenting(false);
    },
    true
  );
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (state.commenting) setCommenting(false);
      if (state.editing) {
        var ce = document.querySelector('[contenteditable="true"].pr-editing-el');
        if (ce) ce.blur();
        else setEditing(false);
      }
      closePopover();
    }
  });

  /* ---- popover (create / edit) ------------------------------------------- */
  var pop = null;
  function closePopover() {
    if (pop) {
      pop.remove();
      pop = null;
    }
  }
  function openPopover(el, x, y, existing) {
    closePopover();
    pop = document.createElement("div");
    pop.id = "pr-pop";
    var meta = existing
      ? "On: <b>" + esc(existing.anchorText || existing.tag) + "</b>"
      : "On &lt;" + el.tagName.toLowerCase() + "&gt;: <b>" + esc(snippet(el, 70)) + "</b>";
    pop.innerHTML =
      '<div class="meta">' + meta + "</div>" +
      '<textarea placeholder="Your comment…"></textarea>' +
      '<div class="row"><button class="save">Save</button>' +
      (existing ? '<button class="del">Delete</button>' : "") +
      '<button class="cancel">Cancel</button></div>';
    document.body.appendChild(pop);
    var px = Math.min(Math.max(8, x + 8), window.innerWidth - 264);
    var py = Math.min(Math.max(8, y + 8), window.innerHeight - 180);
    pop.style.left = px + window.scrollX + "px";
    pop.style.top = py + window.scrollY + "px";
    var ta = pop.querySelector("textarea");
    ta.value = existing ? existing.text : "";
    ta.focus();
    pop.querySelector(".save").addEventListener("click", function () {
      var text = ta.value.trim();
      if (!text) return closePopover();
      if (existing) {
        existing.text = text;
        existing.author = state.reviewer || existing.author || "anon";
        markTouched(existing.id);
      } else {
        state.seq++;
        var id = "c" + state.seq;
        state.comments.push({
          id: id,
          author: state.reviewer || "anon",
          text: text,
          createdAt: new Date().toISOString(),
          anchorText: snippet(el, 140),
          section: nearestSection(el),
          selector: selectorFor(el),
          tag: el.tagName.toLowerCase(),
          slideOrder: SLIDE_ORDER === null ? undefined : SLIDE_ORDER,
        });
        markTouched(id);
      }
      persist();
      render();
      closePopover();
    });
    if (existing)
      pop.querySelector(".del").addEventListener("click", function () {
        removeComment(existing.id);
        closePopover();
      });
    pop.querySelector(".cancel").addEventListener("click", closePopover);
  }

  function removeComment(id) {
    state.comments = state.comments.filter(function (c) {
      return c.id !== id;
    });
    persist();
    render();
  }

  /* ---- locate / jump ------------------------------------------------------ */
  function locate(c) {
    try {
      var el = document.querySelector(c.selector);
      if (el) return el;
    } catch (e) {}
    var nodes = document.getElementsByTagName(c.tag || "*");
    for (var i = 0; i < nodes.length; i++) {
      if (snippet(nodes[i], 140) === c.anchorText) return nodes[i];
    }
    return null;
  }
  function jumpTo(c) {
    var el = locate(c);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("pr-flash");
    setTimeout(function () {
      el.classList.remove("pr-flash");
    }, 1500);
  }

  /* ---- render pins + list ------------------------------------------------- */
  function render() {
    root.querySelector("#pr-cnt").textContent = state.comments.length + state.edits.length;
    // pins
    pins.innerHTML = "";
    state.comments.forEach(function (c, i) {
      var el = locate(c);
      if (!el) return;
      var r = el.getBoundingClientRect();
      var pin = document.createElement("div");
      pin.className = "pr-pin" + (c.sent ? " sent" : "");
      pin.textContent = i + 1;
      pin.title = (c.author || "anon") + ": " + c.text;
      pin.style.left = r.right + window.scrollX - 4 + "px";
      pin.style.top = r.top + window.scrollY + 11 + "px";
      pin.addEventListener("click", function (ev) {
        ev.stopPropagation();
        openPopover(el, r.right - 248, r.top, c);
      });
      pins.appendChild(pin);
    });
    // tray list (comments + edits)
    var list = root.querySelector("#pr-list");
    list.innerHTML = "";
    if (!state.comments.length && !state.edits.length) {
      list.innerHTML = EDIT_ONLY
        ? '<div id="pr-empty">Click any text on the slide to edit it in place. Changes save automatically.</div>'
        : '<div id="pr-empty">Nothing yet. <b>+ Comment</b> to pin a note, or <b>✎ Edit text</b> to change copy in place.</div>';
      return;
    }
    // Newest first: latest comments + edits go to the top of the tray.
    for (var ci = state.comments.length - 1; ci >= 0; ci--) {
      (function (c, num) {
        var row = document.createElement("div");
        row.className = "pr-row" + (c.sent ? " sent" : "");
        row.innerHTML =
          '<div class="top"><span class="pn">' + num + "</span>" +
          '<span class="who">' + esc(c.author || "anon") + "</span>" +
          (c.sent ? '<span class="stag">sent' + (c.round ? " r" + c.round : "") + "</span>" : "") +
          '<button class="del" title="Delete">&times;</button></div>' +
          '<div class="txt">' + esc(c.text) + "</div>" +
          '<div class="anchor"><b>' + esc(c.section || "") + "</b> · " + esc((c.tag || "") + " · " + (c.anchorText || "")) + "</div>";
        row.addEventListener("click", function () { jumpTo(c); });
        row.querySelector(".del").addEventListener("click", function (ev) { ev.stopPropagation(); removeComment(c.id); });
        list.appendChild(row);
      })(state.comments[ci], ci + 1);
    }
    for (var ei = state.edits.length - 1; ei >= 0; ei--) {
      (function (e) {
        var row = document.createElement("div");
        row.className = "pr-row edit" + (e.sent ? " sent" : "");
        row.innerHTML =
          '<div class="top"><span class="pn">✎</span>' +
          '<span class="who">' + esc(e.author || "anon") + " · edit</span>" +
          (e.sent ? '<span class="stag">sent' + (e.round ? " r" + e.round : "") + "</span>" : "") +
          '<button class="del" title="Revert edit">&times;</button></div>' +
          '<div class="txt">' + esc(e.text) + "</div>" +
          '<div class="was">' + esc(e.original) + "</div>" +
          '<div class="anchor"><b>' + esc(e.section || "") + "</b> · " + esc(e.tag || "") + "</div>";
        row.addEventListener("click", function () { jumpTo(e); });
        row.querySelector(".del").addEventListener("click", function (ev) { ev.stopPropagation(); removeEdit(e.id); });
        list.appendChild(row);
      })(state.edits[ei]);
    }
  }

  var rafPending = false;
  function scheduleReposition() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      render();
    });
  }
  window.addEventListener("scroll", scheduleReposition, true);
  window.addEventListener("resize", scheduleReposition);

  /* ---- extract / download ------------------------------------------------- */
  function buildDocument() {
    var STD = /^(H[1-6]|P|LI|BLOCKQUOTE|FIGCAPTION|BUTTON|A)$/;
    var LEAF = /^(DIV|SPAN|TD|TH|DT|DD)$/;
    var PROSE = "p,li,h1,h2,h3,h4,h5,h6,blockquote,figcaption,button,a";
    var out = [];
    Array.prototype.forEach.call(document.body.querySelectorAll("*"), function (n) {
      if (isUi(n)) return;
      var tag = n.tagName;
      var take = STD.test(tag) || (LEAF.test(tag) && n.children.length === 0 && !n.closest(PROSE));
      if (!take) return;
      var text = snippet(n, 400);
      if (!text) return;
      var s = selectorFor(n);
      var cs = state.comments
        .filter(function (c) {
          return c.selector === s;
        })
        .map(function (c) {
          return { author: c.author, text: c.text };
        });
      var item = { tag: n.tagName.toLowerCase(), text: text, selector: s, comments: cs };
      var ed = state.edits.filter(function (x) { return x.selector === s; })[0];
      if (ed) {
        item.edited = true;
        item.original = ed.original;
        item.editedBy = ed.author;
      }
      out.push(item);
    });
    return out;
  }
  function extract() {
    var reviewers = [];
    function noteR(a) { if (a && reviewers.indexOf(a) < 0) reviewers.push(a); }
    state.comments.forEach(function (c) { noteR(c.author); });
    state.edits.forEach(function (e) { noteR(e.author); });
    noteR(state.reviewer);
    var data = {
      tool: "proofing-room",
      version: "2",
      url: location.href,
      path: location.pathname,
      title: document.title,
      extractedAt: new Date().toISOString(),
      reviewers: reviewers,
      comments: state.comments,
      edits: state.edits,
      document: buildDocument(),
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    var slug = location.pathname.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home";
    a.href = URL.createObjectURL(blob);
    a.download = "proofing-" + slug + "-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function esc(s) {
    return (s || "").replace(/[&<>]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c];
    });
  }

  if (EDIT_ONLY && SERVER_OVERRIDES) {
    // FEATURE 1 capture flow: server is authoritative. seedFromServer() applies
    // the stored text + captures the TRUE original (the route did not pre-apply
    // the overlay) and replaces state.edits. Then auto-enter text-edit mode so
    // the reviewer can immediately click-to-edit.
    seedFromServer();
    setEditing(true);
  } else {
    // Read views / comment mode: restore the localStorage working copy as before.
    applyEdits();
    if (EDIT_ONLY) setEditing(true);
  }
  render();
  // NOTE: we intentionally do NOT bridge on load. Comments restored from
  // localStorage were already ingested into Convex when first created; re-posting
  // them here would duplicate rows (Convex carries no clientId to de-dup across
  // reloads). The bridge fires only on genuine user mutations (persist()), and
  // the host de-dupes within a session by clientId. Convex is the reload source
  // of truth for pins; localStorage is just proofing-room's local working copy.
  window.__proofingRoom = { extract: extract, render: render, state: state, bridge: bridge };
})();
