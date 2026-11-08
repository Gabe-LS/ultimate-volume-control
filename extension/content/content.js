// Isolated world: finds the audio, routes it through the limiter, and reports. Injected only on approved sites.
(() => {
  if (globalThis.__uvcContent) return;
  globalThis.__uvcContent = true;

  const ATTACH_RAMP_SECONDS = 0.1;
  const READY_TIMEOUT_MS = 3000;
  const SILENCE_WATCH_MS = 2000;
  const REST_AFTER_MS = 10000; // With nothing playing for this long, the audio engine stops until something plays again.
  const WAKE_TIMEOUT_MS = 1000;
  const LOWERED_EVERY_MS = 250;
  const SILENCE_EVERY_MS = 500;
  const FRAMES_REPORT_EVERY_MS = 5000; // Measuring frames makes the browser lay the page out, so not on every page change.
  const ROUTED_MARK = "data-uvc-routed";
  const startedEarly = document.readyState === "loading"; // Registered, so the hook was there before the page's own code.
  const earlierInstance = !!document.documentElement?.hasAttribute(ROUTED_MARK);
  // After an extension update, the copy of this script from before it is cut off from the extension, but keeps the audio
  // it routed: only its graph can carry it. The new copy takes it over (see "After an extension update" below).
  const instanceId = Math.random().toString(36).slice(2);
  let follower = false; // This copy has been taken over by a newer one, and only does what that one asks.
  let inheritedRouted = 0; // Elements an earlier copy routed and this copy now controls.

  let gainDb = 0;
  let ceilingDb = 0;
  let doNotRoute = false;
  let dead = false;
  let status = "idle";
  let detail = "";
  let pendingRestore = false;

  const routed = new WeakMap(); // element -> { source }
  const pageOwned = new WeakSet();
  const known = new Set();
  const processors = []; // Every limiter instance in this frame.
  let own = null;

  // The worklet reports ten times a second and the popup reads five times. Each reading keeps the highest peaks, limiting and
  // momentary loudness since the last one, so a short peak between two readings still shows. The rest is the latest report.
  const HELD = ["peakInDb", "peakOutDb", "momentary", "maxCatchDb"];
  function holdMeters(held, next) {
    if (!held) return next;
    const out = { ...next };
    for (const k of HELD) if (held[k] > out[k]) out[k] = held[k];
    return out;
  }

  const send = (message) => {
    if (dead) return Promise.resolve();
    try {
      return chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      // The extension was reloaded. Leave the graph as it is: audio keeps playing.
      dead = true;
      return Promise.resolve();
    }
  };

  let reported = "";
  function report() {
    // Only frames big enough to be a player. Trackers and sign-in helpers are usually tiny or hidden.
    const big = (f) => { const r = f.getBoundingClientRect(); return r.width >= 200 && r.height >= 100; };
    const iframes = [...new Set([...document.querySelectorAll("iframe[src]")].filter(big).map((f) => { try { return new URL(f.src, location.href).origin; } catch { return null; } }).filter((o) => o && o !== "null" && o !== self.origin))];
    const payload = { status, detail, routedCount: countRouted(), graphs: processors.length, iframes, top: window === top, early: startedEarly, sounding, stale: earlierInstance };
    const key = JSON.stringify(payload);
    if (key === reported) return;
    reported = key;
    send({ type: "frame-state", ...payload });
  }
  function setStatus(next, why = "") {
    status = next;
    detail = why;
    report();
  }
  let routedTotal = 0;
  const countRouted = () => routedTotal + inheritedRouted;
  // One status per frame: audio that can't be boosted doesn't hide a boost that is running.
  const boosting = () => routedTotal > 0 || processors.length > 0;

  // ---- Processing ---------------------------------------------------------------------------------------------------

  // A suspended context never constructs its processor, so nothing can be built until it runs.
  const whenRunning = (ctx) => (ctx.state === "running" ? Promise.resolve() : new Promise((done) => {
    const check = () => { if (ctx.state === "running") { ctx.removeEventListener("statechange", check); done(); } };
    ctx.addEventListener("statechange", check);
  }));

  // Chrome renders an audio worklet at half speed after a page comes back from the back/forward cache (seen with a page's
  // own worklet too): the sound is chopped every 256 samples. A page with ours in it is kept out of the cache instead, so
  // going back loads it again, as Chrome does for any page it doesn't cache.
  let outOfCache = false;
  function stayOutOfCache() {
    if (outOfCache) return;
    outOfCache = true;
    addEventListener("unload", () => {});
  }

  function attachProcessor(ctx, onFault) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (p) => { if (!settled) { settled = true; resolve(p); } };
      setTimeout(() => done(null), READY_TIMEOUT_MS);

      const make = (node, post) => ({
        node, post, energy: 0, reductionDb: 0, effectiveBoostDb: gainDb, clips: 0, lateEvents: 0, maxLagMs: 0, silentSince: 0, faulted: false,
      });
      const useWorklet = async () => {
        if (!ctx.audioWorklet) throw new Error("No AudioWorklet here");
        await ctx.audioWorklet.addModule(chrome.runtime.getURL("worklet/processor.js"));
        const node = new AudioWorkletNode(ctx, "uvc-processor", {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2,
          channelCountMode: "explicit", channelInterpretation: "speakers", processorOptions: { ceilingDb },
        });
        const p = make(node, (m) => node.port.postMessage(m));
        node.port.onmessage = (e) => {
          const m = e.data;
          if (m.type === "ready") return done(p);
          if (m.type === "state") {
            Object.assign(p, m);
            p.metersHeld = m.meters ? holdMeters(p.metersHeld, m.meters) : null;
            return afterState();
          }
          if (m.type === "fault") { p.faulted = true; onFault(p, m.message); }
        };
        node.addEventListener("processorerror", () => { p.faulted = true; onFault(p, "processor error"); });
      };
      // Plain HTTP pages have no AudioWorklet, and a page's CSP can block one on its own context. ScriptProcessor is
      // deprecated, but it runs the same limiter, so the ceiling still holds.
      const useScriptProcessor = async () => {
        const { Limiter } = await import(chrome.runtime.getURL("dsp/limiter.js"));
        const { Monitor } = await import(chrome.runtime.getURL("dsp/monitor.js"));
        const limiter = new Limiter(ctx.sampleRate, { ceilingDb });
        const monitor = new Monitor(ctx.sampleRate, limiter.latencySamples);
        const node = ctx.createScriptProcessor(1024, 2, 2);
        const p = make(node, (m) => {
          if (m.type === "target") limiter.setTargetDb(m.db, m.rampSeconds);
          else if (m.type === "ceiling") limiter.setCeilingDb(m.db);
          else if (m.type === "restore") limiter.restoreBoost();
          else monitor.handle(m);
        });
        let sum = 0, count = 0;
        node.onaudioprocess = (ev) => {
          const inL = ev.inputBuffer.getChannelData(0), inR = ev.inputBuffer.getChannelData(1);
          const outL = ev.outputBuffer.getChannelData(0), outR = ev.outputBuffer.getChannelData(1);
          for (let i = 0; i < inL.length; i++) sum += Math.max(inL[i] * inL[i], inR[i] * inR[i]);
          count += inL.length;
          try {
            limiter.process(inL, inR, outL, outR, inL.length);
            monitor.process(inL, inR, outL, outR, inL.length);
          } catch (e) {
            outL.set(inL);
            outR.set(inR);
            if (!p.faulted) { p.faulted = true; onFault(p, String(e)); }
          }
          if (count >= ctx.sampleRate / 10) {
            p.energy = sum / count;
            p.reductionDb = limiter.lastReductionDb;
            p.effectiveBoostDb = limiter.effectiveBoostDb;
            p.targetDb = limiter.targetDb;
            p.clips = limiter.clipCount;
            p.meters = monitor.metersOn ? { ...monitor.read(), maxCatchDb: limiter.readMaxCatchDb() } : null;
            p.metersHeld = p.meters ? holdMeters(p.metersHeld, p.meters) : null;
            sum = 0;
            count = 0;
            afterState();
          }
        };
        p.scriptProcessor = true;
        done(p);
      };
      useWorklet().catch(() => useScriptProcessor()).catch(() => done(null));
    });
  }

  function ownGraph() {
    if (own) return own;
    const ctx = new AudioContext({ latencyHint: "playback" });
    own = { ctx, processor: null, sources: [] };
    own.ready = whenRunning(ctx).then(() => attachProcessor(ctx, (p) => {
      // Audio must survive a dead processor: reconnect every source straight to the output, at unity.
      for (const s of own.sources) {
        try { s.disconnect(); s.connect(ctx.destination); } catch {}
      }
      setStatus("fault", "The audio engine stopped. Audio continues without boost.");
    })).then((p) => {
      if (!p) {
        // Nothing will ever be connected to it, so it mustn't keep the audio device running.
        own.failed = true;
        ctx.close().catch(() => {});
        return null;
      }
      own.processor = p;
      p.post({ type: "ceiling", db: ceilingDb }); // A change while it was being built didn't reach it.
      p.node.connect(ctx.destination);
      p.post({ type: "target", db: gainDb, rampSeconds: ATTACH_RAMP_SECONDS });
      processors.push(p);
      stayOutOfCache();
      if (metersOn) p.post({ type: "meters", on: true });
      return p;
    });
    const resume = () => ctx.resume().catch(() => {});
    resume();
    // A click on a page at rest isn't a reason to start the engine. Playing something is, and that wakes it anyway.
    for (const t of ["pointerdown", "keydown", "click"]) addEventListener(t, () => { if (!resting) resume(); }, { capture: true });
    ctx.addEventListener("statechange", () => {
      if (ctx.state === "running") {
        resting = false;
        if (status === "waiting") updateActive();
        restWhenIdle();
      } else if (ctx.state === "suspended" && routedTotal > 0 && !resting) {
        setStatus("waiting", "Waiting for a click on the page");
      }
      for (const el of known) route(el);
    });
    return own;
  }

  // A running audio engine costs as much with nothing to play as it does with music. So when everything is paused, it stops.
  // Only our own: a page's own audio context is the page's to run. A sound that starts wakes it from the element's play event.
  let resting = false;
  let restTimer = 0;
  function restWhenIdle() {
    if (!own?.processor) return;
    if (anyPlaying()) {
      clearTimeout(restTimer);
      restTimer = 0;
      wake();
    } else if (!restTimer && !resting && own.ctx.state === "running") {
      restTimer = setTimeout(() => {
        restTimer = 0;
        if (anyPlaying() || own.ctx.state !== "running") return;
        resting = true;
        own.processor.post({ type: "stopping" });
        own.ctx.suspend().catch(() => { resting = false; });
      }, REST_AFTER_MS);
    }
  }
  function wake() {
    if (!resting) return;
    own.ctx.resume().catch(() => {});
    // If the browser won't start it again, this is the same as a page that hasn't had its click yet.
    setTimeout(() => {
      if (!resting || own.ctx.state === "running") return;
      resting = false;
      if (routedTotal > 0) setStatus("waiting", "Waiting for a click on the page");
    }, WAKE_TIMEOUT_MS);
  }

  // ---- Routing ------------------------------------------------------------------------------------------------------

  const isStream = (el) => el.srcObject instanceof MediaStream;

  // captureStream() refuses tainted media at once, with no network request and nothing to undo. Routing tainted media
  // would be silent and permanent. Encrypted media also makes it throw although routing works, so it is exempt.
  function isTainted(el) {
    if (isStream(el) || el.mediaKeys) return false;
    try {
      el.captureStream().getTracks().forEach((t) => t.stop());
      return false;
    } catch {
      return true;
    }
  }

  // Only the known-safe cases. self.origin, not location.origin: on a sandboxed page location.origin still names the site.
  function routable(el) {
    if (isStream(el)) return true;
    const src = el.currentSrc;
    if (!src) return false;
    if (el.crossOrigin || src.startsWith("blob:") || src.startsWith("data:")) return true;
    try { return new URL(src).origin === self.origin; } catch { return false; }
  }

  async function route(el) {
    if (dead || gainDb <= 0 || doNotRoute || routed.has(el) || pageOwned.has(el)) return;
    // Held by the copy from before an extension update: its sound already reaches a limiter this copy controls.
    if (inherited() && heldByEarlier(el)) { pageOwned.add(el); return; }
    if (el.paused || el.readyState < 3) return; // Taint is not known until data is flowing.
    // A muted page with no click yet can't start audio anyway. It's looked at again on unmute, which is when a click comes.
    if (el.muted && !navigator.userActivation?.hasBeenActive && !routed.has(el)) return;
    if (!routable(el) || isTainted(el)) {
      // A muted background video isn't what the user is listening to. It's checked again if it is unmuted.
      if (!el.muted && el.volume > 0 && !boosting()) setStatus("unsupported", "This audio comes from another server that doesn't allow boosting. It still plays normally.");
      return;
    }
    const graph = ownGraph();
    if (graph.failed) {
      // Said again: going to 100% and back (a capture attempt does that) clears the status.
      if (!boosting()) setStatus("unsupported", "The audio engine could not start on this page. Audio plays normally.");
      return;
    }
    // Until the context runs, the element keeps playing directly, so it stays audible.
    if (graph.ctx.state !== "running") {
      if (resting) wake(); // The context's own state change comes back here.
      else setStatus("waiting", "Waiting for a click on the page");
      return;
    }
    routed.set(el, {});
    const processor = await graph.ready;
    if (!processor) {
      routed.delete(el);
      if (!boosting()) setStatus("unsupported", "The audio engine could not start on this page. Audio plays normally.");
      return;
    }
    // It may have changed while the engine was starting, and routing can't be undone. It's looked at again when it plays.
    if (pageOwned.has(el) || el.paused || el.readyState < 3 || !routable(el) || isTainted(el)) { routed.delete(el); return; }
    try {
      if (isStream(el)) {
        // Muting the element instead would take away the page's own mute, so volume is what's silenced.
        const stream = routeStream(el, graph, processor, true);
        routed.set(el, { source: stream.source, stream, routedAt: performance.now() });
      } else {
        const source = graph.ctx.createMediaElementSource(el);
        source.connect(processor.node);
        graph.sources.push(source);
        routed.set(el, { source, routedAt: performance.now() });
      }
      document.documentElement.setAttribute(ROUTED_MARK, "");
      routedTotal++;
      updateActive();
      restWhenIdle();
    } catch (e) {
      routed.delete(el);
      if (e.name === "InvalidStateError") {
        pageOwned.add(el);
        if (!heldByEarlier(el)) setStatus("site-owned", "This site handles its own audio");
      } else {
        setStatus("unsupported", "This audio could not be routed. It still plays normally.");
      }
    }
  }

  // A media element source carries nothing for a stream, so the stream itself is routed, at the element's level. When the
  // element plays the stream itself (pinned), its own output is held at volume 0, and the page's volume is followed here.
  function routeStream(el, graph, processor, pinned) {
    const stream = el.srcObject;
    const source = graph.ctx.createMediaStreamSource(stream);
    const level = graph.ctx.createGain();
    source.connect(level);
    let wanted = el.volume;
    const follow = () => {
      if (!pinned) wanted = el.volume;
      else if (el.volume !== 0) {
        wanted = el.volume;
        el.volume = 0;
      }
      level.gain.value = el.muted || el.paused ? 0 : wanted;
    };
    // The page setting 0 on an element already at 0 changes nothing and fires nothing. The MAIN-world hook says so.
    const zero = () => { wanted = 0; follow(); };
    const events = ["volumechange", "pause", "play"];
    for (const t of events) el.addEventListener(t, follow);
    el.addEventListener("uvc:volume-zero", zero);
    follow();
    level.connect(processor.node);
    graph.sources.push(level);
    return {
      source, of: stream,
      drop() {
        for (const t of events) el.removeEventListener(t, follow);
        el.removeEventListener("uvc:volume-zero", zero);
        source.disconnect();
        level.disconnect();
        const i = graph.sources.indexOf(level);
        if (i >= 0) graph.sources.splice(i, 1);
        if (pinned) el.volume = wanted;
      },
    };
  }

  // A new srcObject, or a src in place of one, isn't carried by the route made for the old one.
  function followStream(el) {
    const r = routed.get(el);
    if (!r?.source) return;
    if (r.stream) {
      if (el.srcObject === r.stream.of) return;
      r.stream.drop();
      routed.delete(el);
      routedTotal--;
      route(el); // Again when it can play, from its own events.
    } else if (el.srcObject !== (r.extra?.of ?? null)) {
      // Routed through a media element source, which carries nothing once the element is given a stream: the element then
      // plays the stream itself, so it is silenced through its volume while the boosted copy plays, as for any stream.
      r.extra?.drop();
      r.extra = null;
      try {
        if (isStream(el)) r.extra = routeStream(el, own, own.processor, true);
      } catch {} // A stream with no audio track has nothing to carry.
    }
  }

  const inherited = () => processors.some((p) => p.relay);
  function updateActive() {
    if (routedTotal > 0 || pageGraphs > 0 || inherited()) setStatus("active");
  }

  // `known` lets go of elements the page has dropped, so they can be collected. One that is used again comes back
  // through its own events. Routed elements stay: their source node holds them anyway.
  const adopted = new WeakSet();
  let pruneAt = 64;
  function adopt(el) {
    known.add(el);
    if (adopted.has(el)) return route(el);
    adopted.add(el);
    if (known.size >= pruneAt) {
      for (const k of known) if (k !== el && !k.isConnected && k.paused && !routed.get(k)?.source) known.delete(k);
      pruneAt = Math.max(64, 2 * known.size);
    }
    for (const t of ["loadedmetadata", "canplay", "play", "playing", "volumechange"]) el.addEventListener(t, () => adopt(el));
    el.addEventListener("playing", () => {
      // A routed element cannot be unrouted. If it later turns tainted, all that is left is to say so.
      if (routed.get(el)?.source && isTainted(el)) setStatus("possible-silence", "The audio changed to a source that can't be boosted, and may be silent.");
    });
    // A new track on a new page: the lowered boost has done its job.
    for (const t of ["emptied", "loadstart", "ended"]) el.addEventListener(t, () => applyPendingRestore());
    for (const t of ["emptied", "loadstart"]) el.addEventListener(t, () => followStream(el));
    for (const t of ["play", "playing", "pause", "ended", "emptied"]) el.addEventListener(t, restWhenIdle);
    return route(el);
  }

  function scan(root) {
    root.querySelectorAll?.("audio,video").forEach(adopt);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.currentNode; n; n = walker.nextNode()) {
      let sr = n.shadowRoot;
      if (!sr && n instanceof HTMLElement) { try { sr = chrome.dom.openOrClosedShadowRoot(n); } catch {} }
      if (sr) { scan(sr); observer.observe(sr, { childList: true, subtree: true }); }
    }
  }
  const holdsFrame = (n) => n.nodeType === 1 && (n.matches?.("iframe") || n.querySelector?.("iframe"));
  let framesReportedAt = 0;
  const observer = new MutationObserver((list) => {
    let frames = false;
    let added = false;
    for (const m of list) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches?.("audio,video")) adopt(n);
        scan(n);
        if (holdsFrame(n)) added = frames = true;
      }
      for (const n of m.removedNodes) if (holdsFrame(n)) frames = true;
    }
    if (added) send({ type: "frames-changed" }); // Once for the whole batch.
    if (frames || performance.now() - framesReportedAt >= FRAMES_REPORT_EVERY_MS) {
      framesReportedAt = performance.now();
      report();
    }
  });

  // ---- The page's own audio, through the MAIN-world hook -------------------------------------------------------------

  let pageGraphs = 0;
  let pendingContext = null;
  document.addEventListener("uvc:element", (e) => { if (e.relatedTarget) adopt(e.relatedTarget); }, true);
  document.addEventListener("uvc:context", (e) => { pendingContext = e.relatedTarget; }, true);
  // With all-sites access the hook is on pages that have no boost. Their audio only ever passes through the master at 100%,
  // and the processor is added if and when the user turns the page up.
  const waitingMasters = [];
  const cutOff = () => dead || !chrome.runtime?.id;
  document.addEventListener("uvc:master", (e) => {
    if (follower) return;
    const entry = { master: e.relatedTarget, ctx: pendingContext };
    if (gainDb > 0 && !cutOff()) attachMaster(entry);
    else waitingMasters.push(entry);
  }, true);
  async function attachMaster({ master, ctx }) {
    pageGraphs++;
    if (ctx.state !== "running" && !boosting()) setStatus("waiting", "Waiting for a click on the page");
    await whenRunning(ctx); // The page's audio runs through the master at 100% until then, so it stays audible.
    const p = await attachProcessor(ctx, (faulted) => {
      try { faulted.node.disconnect(); master.disconnect(); master.connect(ctx.destination); } catch {}
      setStatus("fault", "The audio engine stopped. Audio continues without boost.");
    });
    if (!p) {
      setStatus("unsupported", "The audio engine could not start on this page. Audio plays normally.");
      return;
    }
    p.post({ type: "ceiling", db: ceilingDb }); // A change while it was being built didn't reach it.
    master.disconnect();
    master.connect(p.node);
    p.node.connect(ctx.destination);
    document.documentElement.setAttribute(ROUTED_MARK, "");
    p.post({ type: "target", db: gainDb, rampSeconds: ATTACH_RAMP_SECONDS });
    processors.push(p);
    stayOutOfCache();
    if (metersOn) p.post({ type: "meters", on: true });
    // A stopped context sends no more reports, so its last ones mustn't stand for sound still reaching the limiter.
    ctx.addEventListener("statechange", () => {
      if (ctx.state === "running") return;
      Object.assign(p, { energy: 0, reductionDb: 0, meters: null });
      const i = ctx.state === "closed" ? processors.indexOf(p) : -1;
      if (i >= 0) { processors.splice(i, 1); pageGraphs--; }
      afterState();
    });
    updateActive();
  }
  document.addEventListener("uvc:page-source", (e) => {
    const el = e.relatedTarget;
    const r = routed.get(el);
    if (r?.source) {
      const d = own.ctx.createMediaStreamDestination();
      r.source.disconnect();
      r.source.connect(d);
      r.handedOff = true; // Its sound now reaches the page's graph, not our limiter, so silence here means nothing.
      document.dispatchEvent(new MouseEvent("uvc:reply", { relatedTarget: d.stream }));
    } else {
      pageOwned.add(el);
    }
  }, true);

  // ---- Commands -----------------------------------------------------------------------------------------------------

  function anyPlaying() {
    for (const el of known) if (!el.paused && !el.ended && routed.get(el)?.source) return true;
    return false;
  }
  // For the lowered boost across an in-app URL change: the page's own audio counts too. Not for resting, which is ours only.
  function sourceContinues() {
    if (anyPlaying() || processors.some((p) => p !== own?.processor && p.energy > 0)) return true;
    for (const el of known) if (pageOwned.has(el) && !el.paused && !el.ended) return true;
    return false;
  }
  function applyPendingRestore() {
    if (!pendingRestore) return;
    pendingRestore = false;
    for (const p of processors) p.post({ type: "restore" });
  }

  function setGain(db, lookEverywhere = false) {
    const wasOff = gainDb <= 0;
    gainDb = db;
    for (const p of processors) p.post({ type: "target", db });
    wake(); // What the engine does with a change can only be seen while it runs. It goes back to rest afterwards.
    if (db > 0) {
      // Audio already routed stays routed at 100%, so coming back up it's active straight away.
      if (status === "idle") {
        if (routedTotal > 0 || pageGraphs > 0 || inherited()) updateActive();
        else setStatus("ready");
      }
      beginWatching();
      for (const el of known) route(el);
      // Walking the whole page is slow. New elements are seen as they arrive, so a slider being dragged has no need of it.
      if (wasOff || lookEverywhere) scan(document.documentElement);
      for (const entry of waitingMasters.splice(0)) if (entry.ctx.state !== "closed") attachMaster(entry);
    } else {
      setStatus("idle");
    }
  }

  // A routed element playing with nothing reaching the limiter means it is silent because of us, and the user must know.
  const SEEMS_SILENT = "Audio appears to be silent. Reloading will play it without boost.";
  const watchSilence = () => {
    if (dead || gainDb <= 0 || status === "possible-silence") return;
    const processor = own?.processor;
    if (!processor || processor.faulted || own.ctx.state !== "running") return;
    let advancing = false;
    for (const el of known) {
      const r = routed.get(el);
      if (r?.source && !r.handedOff && !isStream(el) && !el.paused && !el.muted && el.volume > 0 && el.readyState >= 3) {
        // Decoded audio rising too: a video with no sound track plays on, with nothing to hear.
        const bytes = el.webkitAudioDecodedByteCount;
        if (r.lastTime !== undefined && el.currentTime !== r.lastTime && bytes > r.lastBytes && performance.now() - r.routedAt > 1000) advancing = true;
        r.lastTime = el.currentTime;
        r.lastBytes = bytes;
      }
    }
    if (advancing && processor.energy === 0) {
      processor.silentSince ||= performance.now();
      if (performance.now() - processor.silentSince >= SILENCE_WATCH_MS) setStatus("possible-silence", SEEMS_SILENT);
    } else {
      processor.silentSince = 0;
    }
  };
  // Started by the first boost, so that a page without one has no observer.
  let watching = false;
  function beginWatching() {
    if (watching) return;
    watching = true;
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  // Both checks follow the audio engine's own reports instead of a timer, so that an engine at rest wakes nothing up.
  let loweredAt = 0;
  let silenceAt = 0;
  // Sound reaching the limiter is what clears a "not reached" alarm, so the worker hears of it straight away.
  let sounding = false;
  let heardAt = 0; // The last time sound reached a limiter here: short sounds with gaps are silent most of the time.
  function afterState() {
    if (follower) return relayState();
    const now = performance.now();
    const hearing = processors.some((p) => p.energy > 0);
    if (hearing) heardAt = now;
    if (hearing !== sounding) {
      sounding = hearing;
      report();
    }
    // Only a guess from silence, so sound reaching the limiter again ends it. A source seen to change stays reported.
    if (status === "possible-silence" && detail === SEEMS_SILENT && own?.processor?.energy > 0) {
      own.processor.silentSince = 0;
      updateActive();
    }
    if (now - loweredAt >= LOWERED_EVERY_MS) {
      loweredAt = now;
      reportLowered();
    }
    if (now - silenceAt >= SILENCE_EVERY_MS) {
      silenceAt = now;
      watchSilence();
    }
  }

  // The lowered boost, for the toolbar badge: the popup is usually closed when it happens.
  let loweredText = "";
  const reportLowered = () => {
    if (dead) return;
    // A limiter that hasn't yet reported the current slider position says nothing about lowering.
    const current = processors.filter((p) => Math.abs((p.targetDb ?? gainDb) - gainDb) < 0.01);
    const lowest = current.reduce((v, p) => Math.min(v, p.effectiveBoostDb), gainDb);
    const text = current.length && gainDb - lowest > 0.05 ? String(Math.round(100 * Math.pow(10, lowest / 20))) : "";
    if (text !== loweredText) {
      loweredText = text;
      send({ type: "lowered", text });
    }
  };

  try {
    chrome.runtime.onMessage.addListener((m, _sender, reply) => {
      if (m.type === "gain") {
        if (m.urlChanged) {
          pendingRestore = true;
          if (!sourceContinues()) applyPendingRestore();
        }
        if (m.boostAllowed && doNotRoute) {
          doNotRoute = false;
          setStatus("idle");
        }
        setGain(m.gainDb, m.urlChanged);
        // The worker may have dropped this frame's record, as for a page back from the back/forward cache.
        if (m.urlChanged) { reported = ""; report(); }
        reply({ ok: true });
      } else if (m.type === "live") {
        if (m.watch) watchMeters();
        const best = processors.reduce((a, p) => (!a || p.energy > a.energy ? p : a), null);
        const lowest = processors.reduce((v, p) => Math.min(v, p.effectiveBoostDb), gainDb);
        reply({
          age: performance.now(), // How old this document is.
          status, detail, gainDb,
          effectiveBoostDb: processors.length ? lowest : gainDb,
          // How far the boost has lowered itself, from each limiter's own report, so a slider move in flight doesn't count.
          loweredDb: processors.reduce((v, p) => Math.max(v, (p.targetDb ?? gainDb) - p.effectiveBoostDb), 0),
          reductionDb: best ? best.reductionDb : 0,
          inputEnergy: best ? best.energy : 0,
          heardMsAgo: heardAt ? performance.now() - heardAt : null,
          clips: processors.reduce((v, p) => v + p.clips, 0),
          lateEvents: processors.reduce((v, p) => v + p.lateEvents, 0),
          maxLagMs: processors.reduce((v, p) => Math.max(v, p.maxLagMs), 0),
          scriptProcessor: processors.some((p) => p.scriptProcessor),
          routedCount: countRouted(), graphs: processors.length,
          engine: own?.ctx.state,
          stale: earlierInstance, // An earlier copy of this script, cut off by an extension update, may still be boosting here.
          meters: best ? best.metersHeld || best.meters || null : null,
        });
        // Only the popup's own reads start a new hold: the worker reads too, and mustn't take a peak the popup hasn't shown.
        if (m.watch) for (const p of processors) p.metersHeld = null;
      } else if (m.type === "original") {
        for (const p of processors) p.post({ type: "original", on: m.on });
        reply({ ok: true });
      } else if (m.type === "unwatch") {
        stopMeters();
        reply({ ok: true });
      } else if (m.type === "restore") {
        for (const p of processors) p.post({ type: "restore" });
        wake();
        reply({ ok: true });
      } else if (m.type === "ceiling") {
        ceilingDb = m.db;
        for (const p of processors) p.post({ type: "ceiling", db: m.db });
        wake();
        reply({ ok: true });
      }
    });
  } catch {
    dead = true;
  }

  // ---- Meters, only while the popup is open --------------------------------------------------------------------------

  const WATCH_TIMEOUT_MS = 2000; // Longer than a popup's slowest poll. Reached if a popup dies without saying so.
  let watchedAt = 0;
  let metersOn = false;
  function watchMeters() {
    watchedAt = performance.now();
    if (!metersOn) {
      metersOn = true;
      for (const p of processors) p.post({ type: "meters", on: true });
      const check = setInterval(() => {
        if (!metersOn) clearInterval(check);
        else if (performance.now() - watchedAt > WATCH_TIMEOUT_MS) stopMeters();
      }, 500);
    }
  }
  // Closing the popup also ends the comparison, back to the boosted side.
  function stopMeters() {
    if (!metersOn) return;
    metersOn = false;
    for (const p of processors) {
      p.post({ type: "meters", on: false });
      p.meters = null;
      p.metersHeld = null;
    }
  }

  // ---- After an extension update ------------------------------------------------------------------------------------

  // The copy injected after an update announces itself. Earlier copies hand over what they hold: their limiters become
  // relays, driven by the new copy's commands and reporting back to it, and audio they hadn't boosted yet is passed on.
  // The two copies share only the page, so commands and readings cross it as strings, and nodes as relatedTarget.
  const relayIds = new Map(); // limiter -> id, in a copy that has been taken over
  const relayEvent = (name, data) => document.dispatchEvent(new CustomEvent(`uvc:${name}`, { detail: JSON.stringify(data) }));
  const heldByEarlier = (el) => !document.dispatchEvent(new MouseEvent("uvc:held", { relatedTarget: el, cancelable: true }));
  document.addEventListener("uvc:leader", (e) => {
    if (e.detail === instanceId) return;
    if (!follower) {
      follower = true;
      dead = true;
      observer.disconnect();
      // Relays of yet older copies go: those copies answer the new one themselves.
      for (let i = processors.length - 1; i >= 0; i--) if (processors[i].relay) processors.splice(i, 1);
      inheritedRouted = 0;
      document.addEventListener("uvc:held", (h) => { if (routed.get(h.relatedTarget)?.source) h.preventDefault(); }, true);
      document.addEventListener("uvc:relay", (r) => {
        const { id, m } = JSON.parse(r.detail);
        for (const [p, pid] of relayIds) if (pid === id) p.post(m);
        if (m.type !== "meters") wake(); // As setGain does: what the engine does with a change is seen while it runs.
      }, true);
    }
    for (const p of processors) if (!relayIds.has(p)) relayIds.set(p, `${instanceId}:${relayIds.size}`);
    relayEvent("relay-hello", { routed: routedTotal, limiters: processors.map((p) => ({ id: relayIds.get(p), targetDb: p.targetDb ?? gainDb })) });
    for (const { master, ctx } of waitingMasters.splice(0)) {
      document.dispatchEvent(new MouseEvent("uvc:context", { relatedTarget: ctx }));
      document.dispatchEvent(new MouseEvent("uvc:master", { relatedTarget: master }));
    }
    relayState();
  }, true);
  function relayState() {
    for (const [p, id] of relayIds) {
      relayEvent("relay-state", { id, energy: p.energy, reductionDb: p.reductionDb, effectiveBoostDb: p.effectiveBoostDb, targetDb: p.targetDb, clips: p.clips, lateEvents: p.lateEvents, maxLagMs: p.maxLagMs, meters: p.metersHeld || p.meters || null });
      p.metersHeld = null;
    }
  }
  // In the copy taking over: each earlier limiter becomes one of its own, reached through the page.
  let inheritedDb = 0;
  document.addEventListener("uvc:relay-hello", (e) => {
    if (follower) return;
    const { routed: count, limiters } = JSON.parse(e.detail);
    inheritedRouted += count;
    for (const { id, targetDb } of limiters) {
      if (processors.some((p) => p.relay === id)) continue;
      const p = {
        relay: id, post: (m) => relayEvent("relay", { id, m }),
        energy: 0, reductionDb: 0, effectiveBoostDb: targetDb, targetDb, clips: 0, lateEvents: 0, maxLagMs: 0, silentSince: 0, faulted: false, meters: null,
      };
      processors.push(p);
      inheritedDb = Math.max(inheritedDb, targetDb);
      if (metersOn) p.post({ type: "meters", on: true });
    }
  }, true);
  document.addEventListener("uvc:relay-state", (e) => {
    if (follower) return;
    const { id, ...state } = JSON.parse(e.detail);
    const p = processors.find((x) => x.relay === id);
    if (!p) return;
    Object.assign(p, state);
    p.metersHeld = state.meters ? holdMeters(p.metersHeld, state.meters) : null;
    afterState();
  }, true);

  // ---- Start --------------------------------------------------------------------------------------------------------

  const start = () => {
    addEventListener("pageshow", (e) => { if (e.persisted) { reported = ""; report(); } });
    document.addEventListener("play", (e) => { if (e.target?.matches?.("audio,video")) adopt(e.target); }, true);
    document.addEventListener("playing", (e) => { if (e.target?.matches?.("audio,video")) adopt(e.target); }, true);
    // Earlier copies, cut off by an extension update, hand over now, so the worker hears the volume they were running at.
    document.dispatchEvent(new CustomEvent("uvc:leader", { detail: instanceId }));
    // startedAt lets the worker tell a document from before the update from one a page could have made up since.
    const hello = () => send({ type: "hello", inheritedDb, startedAt: performance.timeOrigin }).then((r) => {
      if (!r) return;
      ceilingDb = r.ceilingDb;
      doNotRoute = r.doNotRoute;
      if (doNotRoute) setStatus("unsupported", "Boost is off on this page, because it went silent before.");
      setGain(r.gainDb);
      report();
    });
    // A page loaded ahead of time isn't the tab's page yet: the worker would take it for the one on show.
    if (document.prerendering) document.addEventListener("prerenderingchange", hello, { once: true });
    else hello();
  };
  if (document.documentElement) start();
  else new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); start(); } }).observe(document, { childList: true });
})();
