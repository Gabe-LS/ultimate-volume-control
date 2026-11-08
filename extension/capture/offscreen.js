// Boosts a whole tab with the same limiter as the page path, for sound a page script can't reach.
// Nothing is recorded or kept: the sound goes from the tab, through the limiter, straight to the speakers.
const sessions = new Map();
const ATTACH_RAMP_SECONDS = 0.1;
const READY_TIMEOUT_MS = 5000;
const WATCH_TIMEOUT_MS = 2000;
const REST_AFTER_MS = 10000; // With the tab silent for this long, the audio engine stops until the tab makes a sound again.

const tell = (m) => chrome.runtime.sendMessage(m).catch(() => {});

// The worklet reports ten times a second and the popup reads five times. Each reading keeps the highest peaks, limiting and
// momentary loudness since the last one, so a short peak between two readings still shows. The rest is the latest report.
const HELD = ["peakInDb", "peakOutDb", "momentary", "maxCatchDb"];
function holdMeters(held, next) {
  if (!held) return next;
  const out = { ...next };
  for (const k of HELD) if (held[k] > out[k]) out[k] = held[k];
  return out;
}

async function start({ tabId, streamId, gainDb, ceilingDb, muted, audible }) {
  await stop(tabId);
  const ctx = new AudioContext({ latencyHint: "playback" });
  let stream;
  try {
    await ctx.resume();
    // The limiter is ready before the tab's sound is taken, so it is never away from the speakers for longer than the switch.
    await ctx.audioWorklet.addModule(chrome.runtime.getURL("worklet/processor.js"));
    const node = new AudioWorkletNode(ctx, "uvc-processor", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2,
      channelCountMode: "explicit", channelInterpretation: "speakers", processorOptions: { ceilingDb },
    });
    const s = { tabId, ctx, node, gainDb, energy: 0, reductionDb: 0, effectiveBoostDb: gainDb, targetDb: 0, clips: 0, lateEvents: 0, maxLagMs: 0, meters: null, faulted: false, loweredText: "", pendingRestore: false, watchedAt: 0, metersOn: false, muted: !!muted, resting: false, restTimer: 0, silent: audible === false };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The audio engine did not start")), READY_TIMEOUT_MS);
      node.port.onmessage = (e) => {
        if (e.data.type === "ready") { clearTimeout(timer); resolve(); }
        onProcessor(s, e.data);
      };
    });
    node.connect(ctx.destination);
    stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } }, video: false });
    s.stream = stream;
    s.source = ctx.createMediaStreamSource(stream);
    s.source.connect(node);
    node.port.postMessage({ type: "target", db: gainDb, rampSeconds: ATTACH_RAMP_SECONDS });
    for (const t of stream.getTracks()) t.addEventListener("ended", () => { if (sessions.get(tabId) === s) { stop(tabId); tell({ type: "capture-ended", tabId }); } });
    sessions.set(tabId, s);
    restWhenSilent(s); // A tab that went quiet while this started rests like any other.
    if (muted) await ctx.suspend();
    return { ok: true };
  } catch (e) {
    // The tab's own playback comes back when its capture stops.
    stream?.getTracks().forEach((t) => t.stop());
    await ctx.close().catch(() => {});
    return { ok: false, error: String(e.message || e) };
  }
}

function onProcessor(s, m) {
  if (m.type === "fault") {
    // The worklet passes its input through when this happens, so the sound carries on at its real level.
    s.faulted = true;
    tell({ type: "capture-fault", tabId: s.tabId });
  } else if (m.type === "state") {
    s.energy = m.energy;
    s.reductionDb = m.reductionDb;
    s.effectiveBoostDb = m.effectiveBoostDb;
    s.targetDb = m.targetDb;
    s.clips = m.clips;
    s.lateEvents = m.lateEvents;
    s.maxLagMs = m.maxLagMs;
    s.meters = m.meters;
    s.metersHeld = m.meters ? holdMeters(s.metersHeld, m.meters) : null;
    // A lowered boost holds while the same sound plays, and a new page's boost starts afresh with the next sound.
    if (s.pendingRestore && m.energy === 0) {
      s.pendingRestore = false;
      s.node.port.postMessage({ type: "restore" });
    }
    reportLowered(s);
    if (s.metersOn && performance.now() - s.watchedAt > WATCH_TIMEOUT_MS) stopMeters(s);
  }
}

function reportLowered(s) {
  const current = Math.abs(s.targetDb - s.gainDb) < 0.01;
  const text = current && s.gainDb - s.effectiveBoostDb > 0.05 ? String(Math.round(100 * Math.pow(10, s.effectiveBoostDb / 20))) : "";
  if (text !== s.loweredText) {
    s.loweredText = text;
    tell({ type: "capture-lowered", tabId: s.tabId, text });
  }
}

// Muted or at rest, the engine stops. Chrome says when a tab goes quiet and when it makes a sound again.
function settle(s) {
  if (!s.muted && !s.resting) return s.ctx.resume();
  s.node.port.postMessage({ type: "stopping" });
  return s.ctx.suspend();
}
function restWhenSilent(s) {
  clearTimeout(s.restTimer);
  s.restTimer = 0;
  if (s.silent) s.restTimer = setTimeout(() => { s.resting = true; settle(s).catch(() => {}); }, REST_AFTER_MS);
}
function sound(s, audible) {
  s.silent = !audible;
  restWhenSilent(s);
  if (audible && s.resting) {
    s.resting = false;
    return settle(s);
  }
}
// What the engine does with a change can only be seen while it runs, and it goes back to rest afterwards.
function wakeForChange(s) {
  if (s.resting) {
    s.resting = false;
    settle(s).catch(() => {});
  }
  restWhenSilent(s);
}

function stopMeters(s) {
  s.metersOn = false;
  s.metersHeld = null;
  s.node.port.postMessage({ type: "meters", on: false });
}

async function stop(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  sessions.delete(tabId);
  clearTimeout(s.restTimer);
  s.stream?.getTracks().forEach((t) => t.stop());
  s.source?.disconnect();
  s.node.disconnect();
  await s.ctx.close().catch(() => {});
}

function live(s, watch) {
  if (watch) {
    s.watchedAt = performance.now();
    if (!s.metersOn) {
      s.metersOn = true;
      s.node.port.postMessage({ type: "meters", on: true });
    }
  }
  const meters = s.metersHeld || s.meters;
  if (watch) s.metersHeld = null; // Only the popup's reads: the worker reads too.
  return {
    capture: true, status: "active", gainDb: s.gainDb, effectiveBoostDb: s.effectiveBoostDb, loweredDb: Math.max(0, s.targetDb - s.effectiveBoostDb), reductionDb: s.reductionDb,
    inputEnergy: s.energy, clips: s.clips, lateEvents: s.lateEvents, maxLagMs: s.maxLagMs, routedCount: 0, graphs: 1, engine: s.ctx.state, meters,
  };
}

const COMMANDS = {
  start: (m) => start(m),
  async stop(m) { await stop(m.tabId); return { remaining: sessions.size }; },
  live(m, s) { return s ? live(s, m.watch) : null; },
  gain(m, s) {
    if (!s) return { ok: false };
    s.gainDb = m.gainDb;
    s.node.port.postMessage({ type: "target", db: m.gainDb });
    if (m.urlChanged) s.pendingRestore = true;
    wakeForChange(s);
    return { ok: true };
  },
  original(m, s) { s?.node.port.postMessage({ type: "original", on: m.on }); return {}; },
  unwatch(_m, s) { if (s?.metersOn) stopMeters(s); return {}; },
  restore(_m, s) { if (s) { s.node.port.postMessage({ type: "restore" }); wakeForChange(s); } return {}; },
  ceiling(m) { for (const s of sessions.values()) { s.node.port.postMessage({ type: "ceiling", db: m.db }); wakeForChange(s); } return {}; },
  async mute(m, s) { if (s) { s.muted = m.muted; await settle(s); } return {}; },
  async sound(m, s) { if (s) await sound(s, m.audible); return {}; },
};

// Only the extension's own worker and popup give orders here, never a page's script.
const trusted = (sender) => sender.id === chrome.runtime.id && (sender.url ? sender.url.startsWith(chrome.runtime.getURL("")) : !sender.tab);
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m.target !== "offscreen" || !trusted(sender)) return false;
  Promise.resolve(COMMANDS[m.type]?.(m, sessions.get(m.tabId))).then(reply, (e) => reply({ ok: false, error: String(e.message || e) }));
  return true;
});
