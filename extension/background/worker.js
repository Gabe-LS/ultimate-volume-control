// Holds no required state in memory: rules are in storage.local, per-tab state in storage.session.
import { indicator } from "./indicator.js";
import { addDoNotRoute, CEILING_MIN_DB, defaultStore, forgetDoNotRoute, migrate, originOf, MAX_GAIN_DB, parseImport, patternFor, regexTaken, resolve, routeKey, targetFor, unusedPatterns, upsertRule } from "../rules/rules.js";

const CONTENT = "content/content.js";
const HOOK = "content/main-hook.js";

const readStore = async () => migrate((await chrome.storage.local.get("store")).store || defaultStore());
const writeStore = (store) => chrome.storage.local.set({ store });
// Every change to the store reads it, changes it and writes it back. One at a time, or a change made meanwhile is lost.
// A change that returns false writes nothing.
let storeQueue = Promise.resolve();
function mutateStore(change) {
  const next = storeQueue.then(async () => {
    const store = await readStore();
    const result = await change(store);
    if (result !== false) await writeStore(store);
    return result;
  });
  storeQueue = next.catch(() => {});
  return next;
}
const isDoNotRoute = (store, url) => !!url && store.doNotRoute.includes(routeKey(url));

// Each tab's unsaved boost, with the save waiting for permission. A custom pattern with nothing saved has no target.
const pendingKey = (tabId) => `pending:${tabId}`;
const readPending = async (tabId) => (await chrome.storage.session.get(pendingKey(tabId)))[pendingKey(tabId)] || null;

const tabKey = (tabId) => `tab:${tabId}`;
async function readTab(tabId) {
  return (await chrome.storage.session.get(tabKey(tabId)))[tabKey(tabId)] || { frames: {} };
}
const writeTab = (tabId, state) => chrome.storage.session.set({ [tabKey(tabId)]: state });

// Several events touch a tab's record at once, and each reads, changes and writes it. One at a time, or they overwrite
// each other. A tab that has closed meanwhile gets no record.
const tabQueues = new Map();
function updateTab(tabId, change) {
  const next = (tabQueues.get(tabId) || Promise.resolve()).then(async () => {
    const state = await readTab(tabId);
    const result = change(state);
    if ((await chrome.tabs.get(tabId).catch(() => null))) await writeTab(tabId, state);
    return result;
  }).catch(() => {});
  tabQueues.set(tabId, next);
  return next;
}

const ALL_SITES = "*://*/*";
const hasAllSites = () => chrome.permissions.contains({ origins: [ALL_SITES] }).catch(() => false);

async function hasPermission(origin) {
  try {
    return await chrome.permissions.contains({ origins: [patternFor(origin)] });
  } catch {
    return false;
  }
}

// ---- Registration -----------------------------------------------------------------------------------------------------

const idsFor = (origin) => ({ isolated: `uvc:${origin}`, main: `uvc-main:${origin}` });

// One idempotent pass: scripts are registered only for site rules above 100%, on origins with permission.
// With all-sites access, one pair covers every page, so the hook is in place before a page's first boost.
async function reconcile() {
  const { rules } = await readStore();
  const wanted = new Map();
  if (await hasAllSites()) {
    wanted.set("all", ALL_SITES);
  } else {
    for (const r of rules) {
      if (r.scope === "site" && r.gainDb > 0 && (await hasPermission(r.origins[0]))) wanted.set(r.origins[0], patternFor(r.origins[0]));
    }
  }
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const stale = existing.filter((s) => {
    const origin = s.id.replace(/^uvc(-main)?:/, "");
    return !wanted.has(origin);
  }).map((s) => s.id);
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
  const have = new Set(existing.map((s) => s.id));
  const add = [];
  for (const [origin, pattern] of wanted) {
    const ids = idsFor(origin);
    const matches = [pattern];
    if (!have.has(ids.isolated)) add.push({ id: ids.isolated, js: [CONTENT], matches, runAt: "document_start", allFrames: false, world: "ISOLATED" });
    if (!have.has(ids.main)) add.push({ id: ids.main, js: [HOOK], matches, runAt: "document_start", allFrames: false, world: "MAIN" });
  }
  if (add.length) await chrome.scripting.registerContentScripts(add);
}

// ---- Injection --------------------------------------------------------------------------------------------------------

// Frames get a script only from here, after the top-level URL has resolved to a rule, and only on permitted origins.
async function inject(tabId) {
  for (const [files, world] of [[[CONTENT], "ISOLATED"], [[HOOK], "MAIN"]]) {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files, world, injectImmediately: true }).catch(() => {});
  }
}

async function sendGain(tabId, gainDb, extra = {}) {
  await updateTab(tabId, (state) => { state.setDb = gainDb; });
  // A capture that is starting finishes first, so this volume reaches it, or a 100% stops it.
  await captureOps.get(tabId);
  // One owner per tab: while capture has the sound, the page stays at 100%, so nothing can boost twice.
  if ((await readTab(tabId)).capture) {
    if (gainDb > 0) {
      await toOffscreen({ type: "gain", tabId, gainDb, urlChanged: extra.urlChanged });
      await showStatus(tabId);
      return;
    }
    await stopCapture(tabId);
  }
  await chrome.tabs.sendMessage(tabId, { type: "gain", gainDb, ...extra }).catch(() => {});
  await showStatus(tabId);
}

// ---- Capture ----------------------------------------------------------------------------------------------------------

// For sound no page script can reach. It is the last resort, because Chrome marks a captured tab as shared.
const OFFSCREEN = "capture/offscreen.html";
let offscreenOpening = null;
async function openOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  offscreenOpening ||= chrome.offscreen.createDocument({ url: OFFSCREEN, reasons: ["USER_MEDIA"], justification: "Boost the sound of a tab the page's own scripts can't reach" }).finally(() => { offscreenOpening = null; });
  await offscreenOpening;
}
async function toOffscreen(message) {
  if (!(await chrome.offscreen.hasDocument())) return null;
  return chrome.runtime.sendMessage({ target: "offscreen", ...message }).catch(() => null);
}

// Starting and stopping a tab's capture take one turn each, so a stop or a new volume never lands in the middle of a start.
// This only orders the work: nothing in it has to survive the worker.
const captureOps = new Map();
function captureOp(tabId, op) {
  const next = (captureOps.get(tabId) || Promise.resolve()).then(op).catch(() => {});
  captureOps.set(tabId, next);
  return next;
}
// Another tab's capture may be starting, and the audio document doesn't count it until it has started.
async function closeOffscreenIfUnused(reply, tabId) {
  if (reply && reply.remaining === 0 && ![...captureStarting].some((id) => id !== tabId)) await chrome.offscreen.closeDocument().catch(() => {});
}

const captureStarting = new Set();
async function startCapture(tab, gainDb) {
  const tabId = tab.id;
  if (captureStarting.has(tabId)) return true;
  captureStarting.add(tabId);
  try {
    return await captureOp(tabId, () => startCaptureNow(tab, gainDb));
  } finally {
    captureStarting.delete(tabId);
  }
}

async function startCaptureNow(tab, fallbackDb) {
  const tabId = tab.id;
  // The volume last set wins over the one this start was asked for, and at 100% there is nothing to start.
  const gainDb = await updateTab(tabId, (state) => {
    if (state.capture) return 0;
    const db = state.setDb ?? fallbackDb;
    // The page goes to 100% first, so the boost is never applied twice.
    if (db > 0) { state.capture = { origin: originOf(tab.url) }; delete state.notReached; }
    return db;
  });
  if (!(gainDb > 0)) return true;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "gain", gainDb: 0 }).catch(() => {});
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await openOffscreen();
    const store = await readStore();
    const now = (await chrome.tabs.get(tabId).catch(() => null)) || tab;
    const r = await chrome.runtime.sendMessage({ target: "offscreen", type: "start", tabId, streamId, gainDb, ceilingDb: store.settings.ceilingDbtp, muted: !!now.mutedInfo?.muted, audible: !!now.audible });
    if (!r?.ok) throw new Error(r?.error || "Capture did not start");
    await showStatus(tabId);
    return true;
  } catch (e) {
    // Without a click on the extension Chrome refuses, and opening the popup is that click. Another capture of this tab, or
    // a failure straight after a click, is something another click wouldn't mend.
    await updateTab(tabId, (state) => {
      delete state.capture;
      state.captureRefused = true;
      state.captureBlocked = !!state.clicked || /active stream/i.test(String(e?.message));
    });
    await closeOffscreenIfUnused(await toOffscreen({ type: "stop", tabId }), tabId);
    await chrome.tabs.sendMessage(tabId, { type: "gain", gainDb }).catch(() => {});
    return false;
  }
}

function stopCapture(tabId) {
  return captureOp(tabId, async () => {
    const { capture } = await readTab(tabId);
    if (!capture) return;
    await updateTab(tabId, (state) => { delete state.capture; delete state.lowered; delete state.frames.capture; });
    await closeOffscreenIfUnused(await toOffscreen({ type: "stop", tabId }), tabId);
    await showStatus(tabId);
  });
}

// The volume this tab should be at, saved or not. The one place a volume is decided: everything that sends one asks here.
async function wantedGain(tabId, url) {
  const origin = url ? originOf(url) : null;
  if (!origin) return 0;
  const unsaved = await unsavedRecord(tabId, url);
  // A custom pattern with nothing saved yet boosts this page whatever else is saved.
  if (unsaved && !unsaved.target) return unsaved.gainDb;
  const rule = resolve((await readStore()).rules, url);
  // A saved volume on a site whose access was taken away is no reason to go on boosting it.
  if (rule && (await hasPermission(origin))) return rule.gainDb;
  return unsaved ? unsaved.gainDb : 0;
}

// ---- Apply ------------------------------------------------------------------------------------------------------------

// Saving is separate from boosting: the boost starts at once, and the rule is saved as soon as permission exists,
// even if the popup closed during the permission prompt.
// A boost that isn't saved stays for as long as the tab stays on that site, such as YouTube moving on to the next video.
async function unsavedRecord(tabId, url) {
  const pending = await readPending(tabId);
  return pending && pending.origin === originOf(url) ? pending : null;
}

const hasAll = async (origins) => (await Promise.all(origins.map(hasPermission))).every(Boolean);

// Saves every waiting boost that now has permission. `except` is a tab that is about to be sent its volume anyway.
async function completeApply(except) {
  const saved = await mutateStore(async (store) => {
    const done = [];
    for (const [key, pending] of Object.entries(await chrome.storage.session.get(null))) {
      if (key.startsWith("pending:") && pending.target && (await hasAll(pending.target.origins))) done.push([key, pending]);
    }
    // Two tabs waiting on one site: the latest slider position is the one saved.
    done.sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
    for (const [, pending] of done) upsertRule(store.rules, pending.target, pending.gainDb, Date.now());
    return done.length ? done : false;
  });
  if (!saved) return false;
  for (const [key, pending] of saved) {
    // A newer slider position written meanwhile is still waiting, and is saved by its own turn.
    const now = (await chrome.storage.session.get(key))[key];
    if (JSON.stringify(now) === JSON.stringify(pending)) await chrome.storage.session.remove(key);
  }
  await reconcile();
  for (const [, pending] of saved) {
    await updateTab(pending.tabId, (state) => { delete state.notRemembered; });
    await showStatus(pending.tabId);
  }
  // Other tabs on the saved sites follow, and a tab allowed only now gets its saved volume.
  await broadcastGains(saved.flatMap(([, p]) => p.target.origins), except);
  return true;
}

// scope is what the popup's selector says. A custom pattern with nothing saved yet boosts this page, and saves on "Save".
async function applyGain({ tabId, url, gainDb, scope = "site", regex }) {
  const origin = originOf(url);
  if (!origin) return { ok: false, error: "This page can't be boosted." };
  // A new position starts afresh: whether it's saved is settled again when the popup closes.
  await updateTab(tabId, (state) => { delete state.notRemembered; });
  await showStatus(tabId);
  const target = scope !== "regex" || regex ? targetFor(scope, url, regex) : null;
  await chrome.storage.session.set({ [pendingKey(tabId)]: { tabId, origin, gainDb, target, at: Date.now() } });
  await inject(tabId);
  await completeApply(tabId);
  // Moving the slider on a page turned off with "Reload without boost" turns it back on.
  await mutateStore((store) => {
    if (!isDoNotRoute(store, url)) return false;
    store.doNotRoute = store.doNotRoute.filter((u) => u !== routeKey(url));
  });
  // A narrower rule still wins, so the page gets what actually applies to it.
  await sendGain(tabId, await wantedGain(tabId, url), { boostAllowed: true });
  await updateTab(tabId, (state) => { delete state.captureRefused; state.clicked = true; });
  checkReached(tabId);
  return { ok: true };
}

// Every tab showing a page these rules touch follows at once: all tabs, or those on the given origins.
async function broadcastGains(origins, except) {
  for (const t of await chrome.tabs.query({})) {
    const origin = t.url ? originOf(t.url) : null;
    if (!origin || t.id === except || (origins && !origins.includes(origin))) continue;
    const gainDb = await wantedGain(t.id, t.url);
    if (gainDb > 0 && (await hasPermission(origin))) await inject(t.id);
    await sendGain(t.id, gainDb);
  }
}

async function releaseUnused(origins, store) {
  if (await hasAllSites()) return;
  const unused = unusedPatterns(store.rules, origins);
  if (unused.length) await chrome.permissions.remove({ origins: unused }).catch(() => {});
}

// Deletes the rule in effect. The page then follows whatever matches next.
async function removeRule({ tabId, url }) {
  const rule = await mutateStore((store) => {
    const rule = resolve(store.rules, url);
    if (!rule) return false;
    store.rules = store.rules.filter((r) => r.id !== rule.id);
    forgetDoNotRoute(store, rule.origins);
    return rule;
  });
  await chrome.storage.session.remove(pendingKey(tabId));
  await reconcile();
  await broadcastGains();
  const store = await readStore();
  if (rule) await releaseUnused([...rule.origins, ...(rule.frameOrigins || [])], store);
  const next = resolve(store.rules, url);
  return { ok: true, gainDb: next ? next.gainDb : 0, nextScope: next ? next.scope : null };
}

async function panelState({ tabId, url }) {
  const store = await readStore();
  const origin = originOf(url);
  const rule = origin ? resolve(store.rules, url) : null;
  const state = await readTab(tabId);
  const pending = await readPending(tabId);
  const iframes = new Set();
  for (const f of Object.values(state.frames)) for (const o of f.iframes || []) iframes.add(o);
  // Offered only when sound is playing that nothing here reached: otherwise the music is already in hand.
  const missing = [];
  for (const o of iframes) if (!(await hasPermission(o))) missing.push(o);
  return {
    origin, rule, frames: state.frames, notRemembered: !!state.notRemembered, notReached: !!state.notReached, captureBlocked: !!state.captureBlocked,
    granted: origin ? await hasPermission(origin) : false,
    audible: !!(await chrome.tabs.get(tabId).catch(() => null))?.audible,
    allSites: await hasAllSites(),
    ceilingDb: store.settings.ceilingDbtp,
    pendingGainDb: pending && pending.tabId === tabId && pending.origin === origin ? pending.gainDb : null,
    missingFrameOrigins: missing,
    canBoost: !!origin,
    capture: !!state.capture,
  };
}

// ---- Status on the toolbar icon ---------------------------------------------------------------------------------------

const icons = (suffix) => ({ 16: `/icons/icon16${suffix}.png`, 32: `/icons/icon32${suffix}.png` });
const ICON = { "": icons(""), on: icons("-on"), alert: icons("-alert") };

// One at a time for each tab, each reading the record afresh, so an older reading can never finish last and leave a stale dot.
const statusQueues = new Map();
function showStatus(tabId) {
  const next = (statusQueues.get(tabId) || Promise.resolve()).then(() => paintStatus(tabId)).catch(() => {});
  statusQueues.set(tabId, next);
  return next;
}

async function paintStatus(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  const state = await readTab(tabId);
  const store = await readStore();
  const origin = tab.url ? originOf(tab.url) : null;
  const rule = origin ? resolve(store.rules, tab.url) : null;
  const granted = origin ? await hasPermission(origin) : false;
  const setDb = state.setDb ?? (await wantedGain(tabId, tab.url));
  const { dot, title } = indicator({
    frames: state.frames,
    capture: !!state.capture,
    notReached: !!state.notReached,
    blocked: !!state.captureBlocked,
    lowered: state.lowered,
    setDb,
    saved: !!rule && granted && Math.abs(rule.gainDb - setDb) < 0.01,
    // Without access the saved volume isn't sent, so the page is at 100% unless the slider has boosted it since.
    noAccess: !!rule && rule.gainDb > 0 && !granted && !(state.setDb > 0),
    doNotRoute: isDoNotRoute(store, tab.url),
  });
  // The record says what Chrome actually accepted. A tab that has just closed refuses both.
  try {
    await chrome.action.setIcon({ tabId, path: ICON[dot] });
    await chrome.action.setTitle({ tabId, title });
    await updateTab(tabId, (s) => { s.dot = dot; });
  } catch {}
}

// The tab is making sound, gain is on, and no limiter is receiving it: the sound is somewhere a page script can't reach.
// Chrome goes on calling a tab audible for seconds after its sound stops, so a new page that's still quiet proves nothing,
// unless it is already playing something that can't be routed.
const AUDIBLE_LAG_MS = 5000;
const HEARD_LATELY_MS = 2500;
async function soundIsOutOfReach(tab, state, gainDb) {
  if (!tab.audible || tab.mutedInfo?.muted || gainDb <= 0) return { reach: false };
  const store = await readStore();
  if (isDoNotRoute(store, tab.url)) return { reach: false };
  const ids = Object.keys(state.frames).filter((id) => id !== "capture"); // "capture" is a record, not a frame.
  const lives = await Promise.all(ids.map((id) => chrome.tabs.sendMessage(tab.id, { type: "live" }, { frameId: Number(id) }).catch(() => null)));
  // A script left from before the extension was updated or reloaded may still be boosting, out of reach of any message.
  // Capture would boost on top of it, so only a reload of the page puts this right.
  if (ids.some((id) => state.frames[id]?.stale) || lives.some((l) => l?.stale)) return { reach: false };
  // Sound heard lately counts too: between short sounds, the latest reading is silent.
  if (lives.some((l) => l && l.graphs > 0 && (l.inputEnergy > 0 || l.heardMsAgo < HEARD_LATELY_MS))) return { reach: false };
  const certain = lives.some((l) => l?.status === "unsupported");
  const top = lives[ids.indexOf("0")];
  if (!certain && top && top.age < AUDIBLE_LAG_MS) return { reach: false, recheckIn: AUDIBLE_LAG_MS - top.age };
  return { reach: true };
}

async function checkReached(tabId, confirming = false) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !tab.url || !originOf(tab.url)) return;
  const state = await readTab(tabId);
  if (state.capture || captureStarting.has(tabId)) return;
  const gainDb = await wantedGain(tabId, tab.url);
  const { reach, recheckIn } = await soundIsOutOfReach(tab, state, gainDb);
  if (recheckIn) setTimeout(() => checkReached(tabId), recheckIn);
  let next = reach;
  // A page that is starting up can sound for a moment before its audio is routed. Only a second look acts on it.
  if (next && !confirming) {
    setTimeout(() => checkReached(tabId, true), SECOND_LOOK_MS);
    return;
  }
  if (next && !state.captureRefused) next = !(await startCapture(tab, gainDb));
  if (next !== !!(await readTab(tabId)).notReached) {
    await updateTab(tabId, (s) => { s.notReached = next; });
    await showStatus(tabId);
  }
}
const NOT_REACHED_DELAY_MS = 1500;
const SECOND_LOOK_MS = 2500; // Longer than Chrome takes to stop calling a tab audible once its sound has just stopped.

// ---- Events -----------------------------------------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await reconcile();
  // After an update or reload, the old script in an open page can no longer be told anything, but goes on processing the
  // audio it holds. A script injected now takes it over, so the page keeps working without a reload. Where the extension
  // has no access, the first click on its icon gives it, and the script goes in then.
  if (reason !== "update") return;
  await chrome.storage.session.set({ updatedAt: Date.now() }); // Before any new script can say hello.
  const later = [];
  for (const t of await chrome.tabs.query({})) {
    // Chrome hides the address of a tab the extension has no access to.
    const origin = t.url ? originOf(t.url) : null;
    if (origin && (await hasPermission(origin))) await inject(t.id);
    else if (!t.url) later.push(t.id);
  }
  await chrome.storage.session.set({ afterUpdate: later });
});
chrome.runtime.onStartup.addListener(() => reconcile());
chrome.permissions.onAdded.addListener(async () => {
  await completeApply();
  await reconcile();
  // A saved volume that access covers again comes back in its open tabs, as it would on their next load.
  for (const t of await chrome.tabs.query({})) {
    const origin = t.url ? originOf(t.url) : null;
    if (!origin || !(await hasPermission(origin))) continue;
    const gainDb = await wantedGain(t.id, t.url);
    if (gainDb <= 0 || (await readTab(t.id)).setDb === gainDb) continue;
    await inject(t.id);
    await sendGain(t.id, gainDb);
  }
});
// The popup can close while the permission prompt is up, and then nothing reports a refusal. So when a popup goes away with
// a save still waiting for permission, say it won't be remembered. An Allow still arrives through onAdded and clears this.
const POPUP_CLOSE_CHECK_MS = 500; // Lets an apply sent just before the popup closed arrive first.
chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith("popup:")) return;
  const tabId = Number(port.name.slice(6));
  port.onDisconnect.addListener(() => {
    // Back to the boosted side, and the meters off, the moment the popup goes. The popup's own goodbye can be lost.
    chrome.tabs.sendMessage(tabId, { type: "unwatch" }).catch(() => {});
    toOffscreen({ type: "unwatch", tabId });
  });
  port.onDisconnect.addListener(() => setTimeout(async () => {
    const pending = await readPending(tabId);
    if (!pending || !pending.target || pending.gainDb <= 0 || (await hasAll(pending.target.origins))) return;
    // The tab may have left the site in the meantime, and then this boost is already over.
    const tab = await chrome.tabs.get(pending.tabId).catch(() => null);
    if (!tab || (tab.url && originOf(tab.url) !== pending.origin) || !tab.url) return;
    await updateTab(pending.tabId, (state) => { state.notRemembered = true; });
    await showStatus(pending.tabId);
  }, POPUP_CLOSE_CHECK_MS));
});
chrome.permissions.onRemoved.addListener(async () => {
  await reconcile();
  // Taking away a site's access ends its saved boost, captured or not. A tab whose address is now hidden has lost access.
  for (const t of await chrome.tabs.query({})) {
    const state = await readTab(t.id);
    const origin = t.url ? originOf(t.url) : null;
    if (origin && !(await hasPermission(origin))) {
      const gainDb = await wantedGain(t.id, t.url);
      if (state.capture || state.setDb !== gainDb) await sendGain(t.id, gainDb);
    } else if (!t.url && (state.setDb > 0 || state.capture)) await sendGain(t.id, 0);
    await showStatus(t.id);
  }
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await stopCapture(tabId);
  chrome.storage.session.remove([tabKey(tabId), pendingKey(tabId)]);
  tabQueues.delete(tabId);
  statusQueues.delete(tabId);
  captureOps.delete(tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  // A capture that is starting hears about sound and muting once it has started.
  if (change.audible !== undefined || change.mutedInfo) await captureOps.get(tabId);
  if (change.audible !== undefined) {
    setTimeout(() => checkReached(tabId), NOT_REACHED_DELAY_MS);
    if ((await readTab(tabId)).capture) await toOffscreen({ type: "sound", tabId, audible: change.audible });
  }
  // A captured tab's sound comes out of the capture, so muting the tab has to silence that too.
  if (change.mutedInfo) await toOffscreen({ type: "mute", tabId, muted: change.mutedInfo.muted });
  // Chrome hides a tab's address from an extension with no access to it, and that means the tab has left the captured site.
  if (!tab.url && change.status === "loading") {
    await stopCapture(tabId);
    // The tab has left for a page with no access, which no script of ours reports on. Chrome has already cleared the icon.
    await updateTab(tabId, (state) => { state.frames = {}; delete state.notReached; delete state.notRemembered; delete state.lowered; delete state.captureRefused; delete state.captureBlocked; delete state.clicked; delete state.setDb; });
    await showStatus(tabId);
  }
  if (!tab.url) return;
  const store = await readStore();
  const rule = resolve(store.rules, tab.url);
  // A same-document navigation keeps its content script, which follows the rule for the new URL. On a full navigation
  // nobody answers, so the old document's state is cleared, and the new document announces itself.
  if (change.url) {
    await updateTab(tabId, (state) => { delete state.setDb; });
    const gainDb = await wantedGain(tabId, tab.url);
    await captureOps.get(tabId);
    const { capture } = await readTab(tabId);
    const keepCapture = capture && capture.origin === originOf(tab.url) && gainDb > 0;
    if (keepCapture) await toOffscreen({ type: "gain", tabId, gainDb, urlChanged: true });
    else if (capture) await stopCapture(tabId);
    const answered = await chrome.tabs.sendMessage(tabId, { type: "gain", gainDb: keepCapture ? 0 : gainDb, urlChanged: true }).catch(() => null);
    if (!answered) {
      await updateTab(tabId, (state) => { state.frames = {}; delete state.notReached; delete state.notRemembered; delete state.lowered; delete state.captureBlocked; delete state.clicked; delete state.setDb; });
      await showStatus(tabId);
      if (gainDb > 0 && (await hasPermission(originOf(tab.url)))) await inject(tabId);
    } else {
      await pruneFrames(tabId);
      await showStatus(tabId);
    }
  }
  // Embedded players can only be reached this way, once the top page is known to match.
  if (change.status === "complete" && rule && rule.gainDb > 0) await inject(tabId);
  // A page with no script to report on it: its sound can't announce itself, and Chrome may never have stopped calling the tab audible.
  if (change.status === "complete") setTimeout(() => checkReached(tabId), AUDIBLE_LAG_MS);
  // A reload keeps the URL, and on a page with no access no script comes back to announce the new document. If nothing
  // answers now, the page is no longer boosted, and neither the old status nor the unsaved boost still applies.
  if (change.status === "complete") {
    const alive = await chrome.tabs.sendMessage(tabId, { type: "live" }, { frameId: 0 }).catch(() => null);
    if (!alive) {
      await stopCapture(tabId);
      await updateTab(tabId, (state) => { state.frames = {}; delete state.notReached; delete state.notRemembered; delete state.lowered; delete state.captureRefused; delete state.captureBlocked; delete state.clicked; delete state.setDb; });
      await chrome.storage.session.remove(pendingKey(tabId));
      await showStatus(tabId);
    }
  }
});

// Pages can only say what they are doing. Everything else comes from the extension's own pages: the popup, the options
// page (which opens in a tab), and the audio document.
const FROM_PAGES = new Set(["hello", "frame-state", "frames-changed", "lowered"]);
const fromExtension = (sender) => sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(""));

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m.target === "offscreen") return false;
  const run = HANDLERS[m.type];
  if (!run) return false;
  if (!FROM_PAGES.has(m.type) && !fromExtension(sender)) return false;
  run(m, sender).then(reply, (e) => reply({ ok: false, error: String(e.message || e) }));
  return true;
});

// Frames that have gone, or moved on to a page with no script of ours, don't answer, and their status goes with them.
async function pruneFrames(tabId) {
  const ids = Object.keys((await readTab(tabId)).frames).filter((id) => id !== "0" && id !== "capture");
  const gone = [];
  for (const id of ids) if (!(await chrome.tabs.sendMessage(tabId, { type: "live" }, { frameId: Number(id) }).catch(() => null))) gone.push(id);
  if (gone.length) await updateTab(tabId, (state) => { for (const id of gone) delete state.frames[id]; });
}

const HANDLERS = {
  async hello(m, sender) {
    // A new top-level document: nothing from the last one applies.
    // Capture stops before this page's own script takes over, so the boost can't apply twice.
    if (sender.frameId === 0 && sender.tab) {
      await stopCapture(sender.tab.id);
      await updateTab(sender.tab.id, (state) => { state.frames = {}; delete state.notReached; delete state.notRemembered; delete state.lowered; delete state.captureRefused; delete state.captureBlocked; delete state.clicked; delete state.setDb; });
      await showStatus(sender.tab.id);
    }
    const store = await readStore();
    const topUrl = sender.tab?.url;
    const capturing = sender.tab && (await readTab(sender.tab.id)).capture;
    let gainDb = capturing || !sender.tab ? 0 : await wantedGain(sender.tab.id, topUrl);
    // After an extension update the tab's records are gone, but the copy of the page script from before it may still be
    // boosting. Its volume carries on as this tab's unsaved boost, as it was before the update.
    const origin = topUrl ? originOf(topUrl) : null;
    // Only a top-level document that was already open at the update: the volume arrives through the page, so a page made
    // since could otherwise claim one and be boosted without the user.
    const { updatedAt = 0 } = await chrome.storage.session.get("updatedAt");
    const fromBeforeUpdate = sender.frameId === 0 && updatedAt > 0 && m.startedAt > 0 && m.startedAt < updatedAt;
    if (!gainDb && !capturing && origin && m.inheritedDb > 0 && fromBeforeUpdate) {
      gainDb = Math.min(MAX_GAIN_DB, m.inheritedDb);
      await chrome.storage.session.set({ [pendingKey(sender.tab.id)]: { tabId: sender.tab.id, origin, gainDb, target: targetFor("site", topUrl), at: Date.now() } });
    }
    return { gainDb, ceilingDb: store.settings.ceilingDbtp, doNotRoute: isDoNotRoute(store, topUrl) };
  },
  async "frame-state"(m, sender) {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return {};
    await updateTab(tabId, (state) => {
      state.frames[sender.frameId] = { status: m.status, detail: m.detail, routedCount: m.routedCount, graphs: m.graphs, iframes: m.iframes, top: m.top, early: m.early, stale: !!m.stale };
    });
    // The top frame reports whenever its frames come or go.
    if (sender.frameId === 0) await pruneFrames(tabId);
    await showStatus(tabId);
    // At once, because audio arriving clears the "not reached" alarm. Raising the alarm takes a second look anyway.
    checkReached(tabId);
    setTimeout(() => checkReached(tabId), 400);
    setTimeout(() => checkReached(tabId), NOT_REACHED_DELAY_MS);
    return {};
  },
  async "frames-changed"(_m, sender) {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      const store = await readStore();
      const rule = sender.tab.url ? resolve(store.rules, sender.tab.url) : null;
      if (rule && rule.gainDb > 0) await inject(tabId);
    }
    return {};
  },
  // Opening the popup is the click Chrome asks for before a tab can be captured.
  async "popup-opened"(m) {
    const { afterUpdate = [] } = await chrome.storage.session.get("afterUpdate");
    if (afterUpdate.includes(m.tabId)) {
      await chrome.storage.session.set({ afterUpdate: afterUpdate.filter((id) => id !== m.tabId) });
      await inject(m.tabId); // The click on the icon has just given access to this tab.
    }
    // captureBlocked stays until the new try below decides it, so the popup never shows a wrong reason meanwhile.
    await updateTab(m.tabId, (state) => { delete state.captureRefused; state.clicked = true; });
    setTimeout(() => checkReached(m.tabId, true), 300);
    return {};
  },
  async "capture-ended"(m) {
    if ((await readTab(m.tabId)).capture) {
      await updateTab(m.tabId, (state) => { delete state.capture; delete state.lowered; delete state.frames.capture; state.captureRefused = true; });
      await closeOffscreenIfUnused(await toOffscreen({ type: "stop", tabId: m.tabId }), m.tabId);
      const tab = await chrome.tabs.get(m.tabId).catch(() => null);
      if (tab) await chrome.tabs.sendMessage(m.tabId, { type: "gain", gainDb: await wantedGain(m.tabId, tab.url) }).catch(() => {});
      await checkReached(m.tabId, true);
      await showStatus(m.tabId);
    }
    return {};
  },
  async "capture-lowered"(m) {
    await updateTab(m.tabId, (state) => { state.lowered = m.text || ""; });
    await showStatus(m.tabId);
    return {};
  },
  async "capture-fault"(m) {
    await updateTab(m.tabId, (state) => { state.frames.capture = { status: "fault", detail: "The audio engine stopped. Audio continues without boost." }; });
    await showStatus(m.tabId);
    return {};
  },
  apply: (m) => applyGain(m),
  commit: async () => ({ saved: await completeApply() }),
  async "permission-result"(m) {
    if (!m.granted) {
      await updateTab(m.tabId, (state) => { state.notRemembered = true; });
      await showStatus(m.tabId); // The boost goes on, so its record stays: the popup still has to show it.
    } else {
      await completeApply();
    }
    return {};
  },
  remove: (m) => removeRule(m),
  async "get-store"() {
    const store = await readStore();
    const rules = await Promise.all(store.rules.map(async (r) => ({ ...r, permissionNeeded: !(await hasAll(r.origins)) })));
    return { ...store, rules, allSites: await hasAllSites() };
  },
  async "rule-save"({ id, gainDb, pattern, origins }) {
    let error = null;
    await mutateStore((store) => {
      const rule = store.rules.find((r) => r.id === id);
      const renamed = rule?.scope === "regex" && pattern !== undefined;
      if (!rule) error = "That rule no longer exists.";
      else if (renamed && regexTaken(store.rules, rule, pattern)) error = "Another rule already uses this pattern.";
      if (error) return false;
      if (typeof gainDb === "number") rule.gainDb = Math.max(0, Math.min(MAX_GAIN_DB, gainDb));
      if (renamed) {
        rule.pattern = pattern;
        rule.origins = origins;
        rule.id = `regex:${pattern}`;
      }
      rule.updatedAt = Date.now();
    });
    if (error) return { ok: false, error };
    await reconcile();
    await broadcastGains();
    return { ok: true };
  },
  async "rule-delete"({ id }) {
    const rule = await mutateStore((store) => {
      const rule = store.rules.find((r) => r.id === id);
      store.rules = store.rules.filter((r) => r.id !== id);
      if (rule) forgetDoNotRoute(store, rule.origins);
      return rule || null;
    });
    await reconcile();
    await broadcastGains();
    if (rule) await releaseUnused([...rule.origins, ...(rule.frameOrigins || [])], await readStore());
    return { ok: true };
  },
  async ceiling({ db }) {
    const ceilingDb = Math.max(CEILING_MIN_DB, Math.min(0, db));
    await mutateStore((store) => { store.settings.ceilingDbtp = ceilingDb; });
    await broadcastCeiling(ceilingDb);
    return { ok: true };
  },
  async import({ text }) {
    let incoming;
    try {
      incoming = parseImport(text);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    // A file without a valid ceiling keeps the one in use.
    const fileCeiling = JSON.parse(text).settings?.ceilingDbtp;
    const ceilingDb = await mutateStore((store) => {
      const byId = new Map(store.rules.map((r) => [r.id, r]));
      for (const r of incoming.rules) if (!byId.has(r.id) || r.updatedAt > byId.get(r.id).updatedAt) byId.set(r.id, r);
      store.rules = [...byId.values()];
      const before = store.settings.ceilingDbtp;
      if (incoming.settings.ceilingDbtp === fileCeiling) store.settings = incoming.settings;
      return store.settings.ceilingDbtp === before ? null : store.settings.ceilingDbtp;
    });
    await reconcile();
    await broadcastGains();
    if (ceilingDb !== null) await broadcastCeiling(ceilingDb);
    return { ok: true, count: incoming.rules.length };
  },
  panel: (m) => panelState(m),
  async restore(m) {
    await chrome.tabs.sendMessage(m.tabId, { type: "restore" }).catch(() => {});
    await toOffscreen({ type: "restore", tabId: m.tabId });
    return {};
  },
  async lowered(m, sender) {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return {};
    await updateTab(tabId, (state) => { state.lowered = m.text || ""; });
    await showStatus(tabId);
    return {};
  },
  async "do-not-route"(m) {
    await mutateStore((store) => { store.doNotRoute = addDoNotRoute(store.doNotRoute, m.url); });
    await chrome.tabs.reload(m.tabId);
    return {};
  },
  async "grant-frames"(m) {
    await mutateStore((store) => {
      const rule = resolve(store.rules, m.url);
      if (!rule) return false;
      rule.frameOrigins = [...new Set([...(rule.frameOrigins || []), ...m.origins])];
    });
    await inject(m.tabId);
    return {};
  },
};

// Open pages and a running capture take a new ceiling at once. A capture that is starting gets it once it has started.
async function broadcastCeiling(db) {
  for (const t of await chrome.tabs.query({})) await chrome.tabs.sendMessage(t.id, { type: "ceiling", db }).catch(() => {});
  await Promise.all([...captureOps.values()]);
  await toOffscreen({ type: "ceiling", db });
}
