// Runs in the page's own world, only on sites the user has approved, because the audio on sites like SoundCloud and
// Spotify cannot be seen from anywhere else. It only detects and redirects. All processing stays in the isolated world.
(() => {
  if (window.__uvcHook) return;
  Object.defineProperty(window, "__uvcHook", { value: true });

  // A relatedTarget is the one channel that carries an object between the two worlds.
  const send = (name, target) => document.dispatchEvent(new MouseEvent(`uvc:${name}`, { relatedTarget: target }));
  let reply = null;
  document.addEventListener("uvc:reply", (e) => { reply = e.relatedTarget; }, true);
  const patch = (fn) => { try { fn(); } catch { send("patch-failed", null); } };

  // Media elements that never enter the DOM.
  const M = HTMLMediaElement.prototype;
  const nativePlay = M.play;
  patch(() => { M.play = function () { send("element", this); return nativePlay.apply(this, arguments); }; });
  patch(() => {
    window.Audio = new Proxy(window.Audio, {
      construct(T, args, newTarget) { const el = Reflect.construct(T, args, newTarget); send("element", el); return el; },
    });
  });
  patch(() => {
    const native = Document.prototype.createElement;
    Document.prototype.createElement = function (name) {
      const el = native.apply(this, arguments);
      if (/^(audio|video)$/i.test(String(name))) send("element", el);
      return el;
    };
  });

  // A stream the extension routes is played by the element at volume 0, so the page setting 0 changes nothing and fires
  // no event. Say so, for the isolated world to follow.
  patch(() => {
    const volume = Object.getOwnPropertyDescriptor(M, "volume");
    Object.defineProperty(M, "volume", {
      ...volume,
      set(v) {
        volume.set.call(this, v);
        if (volume.get.call(this) === 0) this.dispatchEvent(new Event("uvc:volume-zero"));
      },
    });
  });

  // The page's own Web Audio: whatever it sends to the speakers passes through a master node instead.
  const masters = new WeakMap();
  const nativeConnect = AudioNode.prototype.connect;
  const nativeDisconnect = AudioNode.prototype.disconnect;
  const masterFor = (ctx) => {
    let m = masters.get(ctx);
    if (!m) {
      m = ctx.createGain();
      nativeConnect.call(m, ctx.destination);
      masters.set(ctx, m);
      send("context", ctx);
      send("master", m);
    }
    return m;
  };
  const isOutput = (d) => d instanceof AudioDestinationNode && d.context instanceof AudioContext;
  patch(() => {
    // When the hook comes late, on first use, a node may already be connected straight to the speakers. That link is
    // moved to the master, so the sound isn't heard twice, once unlimited.
    AudioNode.prototype.connect = function (dest, ...rest) {
      if (isOutput(dest)) {
        try { nativeDisconnect.call(this, dest, ...rest); } catch {}
        nativeConnect.call(this, masterFor(dest.context), ...rest);
        return dest;
      }
      return nativeConnect.call(this, dest, ...rest);
    };
    AudioNode.prototype.disconnect = function (dest, ...rest) {
      if (isOutput(dest)) {
        try { return nativeDisconnect.call(this, masterFor(dest.context), ...rest); } catch {}
        return nativeDisconnect.call(this, dest, ...rest); // Connected before the hook.
      }
      return nativeDisconnect.call(this, ...(dest === undefined ? [] : [dest, ...rest]));
    };
  });

  // If the page hooks an element we already route, its own call would throw. Hand it a stream of the element instead.
  patch(() => {
    const native = AudioContext.prototype.createMediaElementSource;
    AudioContext.prototype.createMediaElementSource = function (el) {
      reply = null;
      send("page-source", el);
      const stream = reply;
      reply = null;
      return stream ? this.createMediaStreamSource(stream) : native.call(this, el);
    };
  });
})();
