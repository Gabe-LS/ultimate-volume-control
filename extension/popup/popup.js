import { parseOrigins, patternFor, validateRegexRule } from "../rules/rules.js";

const $ = (id) => document.getElementById(id);
const toDb = (percent) => 20 * Math.log10(percent / 100);
const toPercent = (db) => Math.round(100 * Math.pow(10, db / 20));

const STATUS = {
  idle: "Not active",
  active: "Active",
  waiting: "Waiting for a click on the page",
  unsupported: "Unsupported media",
  ready: "Ready. Boost starts when audio plays",
  "site-owned": "Site handles its own audio",
  "possible-silence": "Possible silence",
  fault: "The audio engine stopped",
};
const REMOVE_LABEL = { site: "Remove this site", page: "Remove this page", regex: "Remove this pattern" };
const SCOPE_NAME = { site: "site rule", page: "page rule", regex: "pattern" };
const TIER = { page: 0, regex: 1, site: 2 };
const OVERRIDE_HINT = { page: "This page has its own setting, which takes priority.", regex: "A pattern applies to this page and takes priority." };
const RANGE_DB = 48; // The peak bars span -48 to 0 dB.
const REDUCE_RANGE_DB = 6;
const OVER_TOLERANCE_DB = 0.1;
const NOTE_MS = 6000;

const params = new URLSearchParams(location.search);
const ALL_SITES = "*://*/*";
let tab;
let panel;
let notRemembered = false;
let liveFrames = [];
let note = "";
let noteUntil = 0;

// The panel refreshes slowly by itself, so after anything the person does it refreshes at once.
const send = (m) => {
  const r = chrome.runtime.sendMessage(m);
  if (m.type !== "panel" && m.type !== "popup-opened") r.then(() => pollPanel(), () => {});
  return r;
};
const toCapture = (m) => chrome.runtime.sendMessage({ target: "offscreen", tabId: tab.id, ...m }).catch(() => null);

function showSlider(db) {
  const p = toPercent(db);
  $("slider").value = p;
  showLevel(p);
}
function showLevel(p) {
  $("percent").textContent = `${p}%`;
  $("db").textContent = p === 100 ? "0.0 dB" : `+${toDb(p).toFixed(1)} dB`;
}
const selectedRegex = () => (panel.rule?.scope === "regex" ? { pattern: panel.rule.pattern, origins: panel.rule.origins } : null);

async function init() {
  // tabId is how the automated tests point the popup at a tab, since they can't click the toolbar.
  tab = params.has("tabId") ? await chrome.tabs.get(Number(params.get("tabId"))) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  chrome.runtime.connect({ name: `popup:${tab.id}` }); // Closes by itself with the popup, which is what the worker listens for.
  panel = await send({ type: "panel", tabId: tab.id, url: tab.url });
  if (!panel.canBoost) {
    $("site").textContent = "This page can't be boosted";
    $("status").textContent = "Browser pages and files can't be changed by extensions.";
    document.querySelector(".scope").hidden = true;
    return;
  }
  showPage();
  $("slider").disabled = false; // Only now: the slider's handler needs the panel state.
  send({ type: "popup-opened", tabId: tab.id });
  setInterval(pollPanel, 1000);
  setInterval(pollLive, 200);
  pollPanel();
  pollLive();
}

// The rule in effect on the tab's page. Shown again after Remove, and when the tab moves to another page.
function showPage() {
  $("site").textContent = panel.origin;
  notRemembered = panel.notRemembered;
  showSlider(panel.pendingGainDb ?? panel.rule?.gainDb ?? 0); // pendingGainDb: boosted, but not saved (it wins over a rule this site has no access for).
  $("scope").value = panel.rule?.scope || "site";
  $("regex-origins").value = (selectedRegex()?.origins || [panel.origin]).join("\n");
  $("regex-pattern").value = selectedRegex()?.pattern || "";
  showScope();
}

function showScope() {
  const scope = $("scope").value;
  $("regex").hidden = scope !== "regex";
  const rule = panel.rule;
  const overridden = rule && rule.scope !== scope && TIER[rule.scope] < TIER[scope];
  $("scope-hint").hidden = !overridden;
  if (overridden) $("scope-hint").textContent = OVERRIDE_HINT[rule.scope];
}
function showAccess() {
  const wantsSave = Number($("slider").value) > 100 && $("scope").value !== "regex";
  hide("access", panel.granted || !wantsSave);
}

// One apply at a time, so an older position can never land after a newer one. Moves made while one is on its way
// are sent as one, with wherever the slider is when it leaves.
let applying = Promise.resolve();
let applyQueued = false;
function applySlider() {
  if (applyQueued) return applying;
  applyQueued = true;
  applying = applying.then(() => {
    applyQueued = false;
    const scope = $("scope").value;
    return send({ type: "apply", tabId: tab.id, url: tab.url, gainDb: toDb(Number($("slider").value)), scope, regex: scope === "regex" ? selectedRegex() : undefined });
  }).catch(() => {});
  return applying;
}

// The boost starts at once. Keeping it for next time is a separate choice, offered below the slider.
$("slider").addEventListener("input", () => {
  notRemembered = false;
  showLevel(Number($("slider").value));
  showAccess();
  applySlider();
});
// Letting go saves the final position, only once it has been applied.
$("slider").addEventListener("change", () => applySlider().then(() => send({ type: "commit" })));
$("scope").addEventListener("change", showScope);
// Opened with the mouse: no focus ring once the choice is made. Keyboard use, or leaving and coming back, brings it back.
$("scope").addEventListener("pointerdown", () => $("scope").classList.add("by-pointer"));
for (const type of ["keydown", "blur"]) $("scope").addEventListener(type, () => $("scope").classList.remove("by-pointer"));

// The permission request must come first in the handler, before any await, or Chrome refuses it.
function askFor(origins) {
  chrome.permissions.request({ origins }).then(
    (granted) => { panel.granted = granted; notRemembered = !granted; return send({ type: "permission-result", tabId: tab.id, granted }); },
    () => { notRemembered = true; return send({ type: "permission-result", tabId: tab.id, granted: false }); },
  );
}
$("allow-site").addEventListener("click", () => askFor([patternFor(panel.origin)]));
$("allow-all").addEventListener("click", () => askFor([ALL_SITES]));
$("each-site").addEventListener("click", () => chrome.permissions.remove({ origins: [ALL_SITES] }).then(() => pollPanel()));
$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

// Every website the pattern lists is asked for in this one click.
$("regex-save").addEventListener("click", () => {
  const error = (text) => { $("regex-error").hidden = !text; $("regex-error").textContent = text || ""; };
  const pattern = $("regex-pattern").value.trim();
  let origins;
  try {
    origins = parseOrigins($("regex-origins").value);
  } catch (e) {
    return error(e.message);
  }
  const invalid = validateRegexRule(pattern, origins, tab.url);
  if (invalid) return error(invalid);
  error("");
  send({ type: "apply", tabId: tab.id, url: tab.url, gainDb: toDb(Number($("slider").value)), scope: "regex", regex: { pattern, origins } });
  askFor(origins.map(patternFor));
});

$("remove").addEventListener("click", async () => {
  const r = await send({ type: "remove", tabId: tab.id, url: tab.url });
  panel = await send({ type: "panel", tabId: tab.id, url: tab.url });
  showPage(); // The slider, scope and pattern fields now show the rule it falls back to.
  note = r.nextScope ? `Falls back to ${SCOPE_NAME[r.nextScope]}, +${r.gainDb.toFixed(1)} dB` : "Removed. Back to 100%";
  noteUntil = Date.now() + NOTE_MS;
});
$("restore").addEventListener("click", () => send({ type: "restore", tabId: tab.id }));
$("reload").addEventListener("click", () => send({ type: "do-not-route", tabId: tab.id, url: tab.url }));
$("frames").addEventListener("click", () => {
  const origins = panel.missingFrameOrigins;
  chrome.permissions.request({ origins: origins.map(patternFor) }).then(async (granted) => {
    if (granted) await send({ type: "grant-frames", tabId: tab.id, url: tab.url, origins });
    panel = await send({ type: "panel", tabId: tab.id, url: tab.url });
  });
});

$("compare").addEventListener("click", () => {
  const on = $("compare").getAttribute("aria-pressed") !== "true";
  if (panel.capture) toCapture({ type: "original", on });
  else chrome.tabs.sendMessage(tab.id, { type: "original", on }).catch(() => {});
});
// Back to the boosted side as soon as the popup goes. The content script also times out if this message is lost.
addEventListener("pagehide", () => {
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type: "unwatch" }).catch(() => {});
  toCapture({ type: "unwatch" });
});

// Bars only: numbers changing this fast can't be read. Screen readers still get the value.
function setMeter(id, width, value, text) {
  const meter = $(id);
  meter.firstElementChild.style.width = `${width}%`;
  if (typeof value === "number") {
    meter.setAttribute("aria-valuenow", String(Math.min(Number(meter.getAttribute("aria-valuemax")), value)));
    meter.setAttribute("aria-valuetext", text);
  } else {
    meter.removeAttribute("aria-valuenow");
    meter.setAttribute("aria-valuetext", "No signal");
  }
}
function peakBar(id, db, hot) {
  const has = typeof db === "number" && db > -RANGE_DB;
  setMeter(id, has ? Math.min(100, (100 * (db + RANGE_DB)) / RANGE_DB) : 0, has ? db : null, has ? `${db.toFixed(1)} dB` : "");
  $(id).firstElementChild.classList.toggle("hot", !!hot);
}
const lufs = (v) => (typeof v === "number" && v > -70 ? `${v.toFixed(1)} LUFS` : "–");

function showMeters(hooked) {
  // The pattern editor takes the meters' place: together they wouldn't fit in a popup.
  $("meters").hidden = hooked.length === 0 || $("scope").value === "regex";
  if (!hooked.length) return;
  // The frame producing the audio. A silent frame's reading would say nothing.
  const heard = hooked.reduce((a, f) => ((f.inputEnergy || 0) > (a.inputEnergy || 0) ? f : a), hooked[0]);
  const m = heard.meters;
  const others = hooked.length - 1;
  const playing = hooked.filter((f) => (f.inputEnergy || 0) > 0).length;
  $("frames-note").hidden = others === 0;
  if (others) $("frames-note").textContent = `+${others} ${others === 1 ? "frame" : "frames"}.${playing > 1 ? " The ceiling applies to each one, so together they can go over it." : ""}`;
  if (!m) return;
  const ceiling = panel?.ceilingDb ?? 0;
  const over = !m.original && typeof m.peakOutDb === "number" && m.peakOutDb > ceiling + OVER_TOLERANCE_DB;
  peakBar("meter-in", m.peakInDb);
  peakBar("meter-out", m.peakOutDb, over);
  const reduction = m.maxCatchDb || 0;
  setMeter("meter-gr", Math.min(100, (100 * reduction) / REDUCE_RANGE_DB), reduction, `${reduction.toFixed(1)} dB`);
  $("val-m").textContent = lufs(m.momentary);
  $("val-s").textContent = lufs(m.shortTerm);
  $("compare").setAttribute("aria-pressed", String(!!m.original));
  $("compare").textContent = m.original ? "Back to boosted" : "Hear original";
}

async function pollLive() {
  if (!panel) return;
  const frameIds = Object.keys(panel.frames).filter((id) => id !== "capture"); // "capture" is a record, not a frame.
  const lives = await Promise.all(frameIds.map((id) => chrome.tabs.sendMessage(tab.id, { type: "live", watch: true }, { frameId: Number(id) }).catch(() => null)));
  // While capture has the tab's sound, the page's own limiters are at 100% and say nothing.
  liveFrames = panel.capture ? [await toCapture({ type: "live", watch: true })].filter(Boolean) : lives.filter(Boolean);
  const hooked = liveFrames.filter((f) => f.graphs > 0);
  // Set: the volume the frames were given. A narrower rule can win over the slider's scope, and then the page follows it.
  const setDb = hooked.length ? Math.max(...hooked.map((f) => f.gainDb)) : toDb(Number($("slider").value));
  // Only the boost, as in the tooltip: it lowers and holds. The peaks caught moment to moment are the Limit meter's.
  // Each limiter reports how far it has lowered itself, so a slider move still on its way never shows as lowering.
  const loweredDb = hooked.reduce((v, f) => Math.max(v, f.loweredDb || 0), 0);
  const lowered = loweredDb > 0.05;
  const now = setDb - loweredDb;
  $("marker").style.visibility = hooked.length && setDb > 0 && setDb - now > 0.1 ? "visible" : "hidden";
  $("marker").textContent = `now ${toPercent(Math.max(0, now))}%`;
  hide("restore", hooked.length === 0);
  hide("restore", !lowered, "disabled");
  showMeters(hooked);
}

// Hiding or disabling the focused button would drop keyboard focus to the start of the popup, so it moves to the slider.
function hide(id, on, how = "hidden") {
  const el = $(id);
  if (on && el.contains(document.activeElement)) $("slider").focus();
  el[how] = on;
}

async function pollPanel() {
  // The tab can move to another page with the popup open, such as the next video. What it shows, and what the next
  // action is for, follows the page now in the tab. A page the popup can't see or boost: reopening it there shows that page.
  const now = await chrome.tabs.get(tab.id).catch(() => null);
  if (!now) return;
  const moved = now.url !== tab.url;
  tab = now;
  panel = await send({ type: "panel", tabId: tab.id, url: tab.url });
  if (moved && !panel.canBoost) return window.close();
  if (moved) showPage();
  const rule = panel.rule;
  hide("remove", !rule);
  if (rule) $("remove").textContent = REMOVE_LABEL[rule.scope];
  hide("each-site", !panel.allSites);
  showAccess();
  showScope(); // The rule may have changed since the scope was last chosen.
  // An embedded player is worth asking about only when there's sound that nothing here reached.
  const hearing = liveFrames.some((f) => !f.capture && f.graphs > 0 && (f.inputEnergy || 0) > 0);
  hide("frames", panel.missingFrameOrigins.length === 0 || !rule || !panel.audible || hearing);

  const statuses = Object.values(panel.frames);
  const order = ["fault", "possible-silence", "waiting", "active", "unsupported", "site-owned", "ready", "idle"];
  const current = order.find((s) => statuses.some((f) => f.status === s)) || "idle";
  const detail = statuses.find((f) => f.status === current)?.detail;
  let text = detail || STATUS[current];
  if (panel.capture && current !== "fault" && current !== "possible-silence") text = "Active. Chrome marks this tab as shared while it's boosted this way.";
  else if (panel.notReached && panel.captureBlocked) text = "Can't boost this sound. Another extension may be capturing this tab.";
  // A saved volume with no access isn't running, unless the slider has just been moved on this tab.
  if (rule && !panel.granted && !panel.capture) text = panel.pendingGainDb > 0 ? "Permission needed" : `Boost off: no access to this site. Allow it to boost at ${toPercent(rule.gainDb)}%.`;
  else if (notRemembered) text = `${text.replace(/\.$/, "")}. Will not be remembered`;
  if (Date.now() < noteUntil) text = note;
  $("status").textContent = text;
  hide("reload", current !== "possible-silence");
}

init();
