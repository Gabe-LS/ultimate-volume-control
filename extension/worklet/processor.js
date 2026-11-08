// Thin AudioWorklet wrapper around the limiter. Must never take the audio down: any DSP error passes the input through.
import { Limiter } from "../dsp/limiter.js";
import { Monitor } from "../dsp/monitor.js";

const REPORT_EVERY = Math.round(sampleRate / 128 / 10);

class UvcProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.limiter = new Limiter(sampleRate, { ceilingDb: o.ceilingDb ?? 0 });
    this.monitor = new Monitor(sampleRate, this.limiter.latencySamples);
    this.faulted = false;
    this.quanta = 0;
    this.energy = 0;
    this.frames = 0;
    this.startedAt = Date.now();
    this.startFrame = currentFrame;
    this.lagBase = 0;
    this.lateEvents = 0;
    this.maxLagMs = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
    this.port.postMessage({ type: "ready", latency: this.limiter.latencySamples / sampleRate });
  }

  onMessage(m) {
    if (m.type === "target") this.limiter.setTargetDb(m.db, m.rampSeconds);
    else if (m.type === "ceiling") this.limiter.setCeilingDb(m.db);
    else if (m.type === "restore") this.limiter.restoreBoost();
    else if (m.type === "stopping") this.stopped = true;
    else this.monitor.handle(m);
  }

  // Wall-clock lag behind the audio clock. A jump means the render thread missed its deadline.
  checkDeadline() {
    const lag = Date.now() - this.startedAt - ((currentFrame - this.startFrame) * 1000) / sampleRate;
    // The engine was stopped on purpose, so the audio clock stood still while the wall clock didn't. That isn't lateness.
    if (this.stopped) {
      this.stopped = false;
      this.lagBase = lag;
    }
    if (lag < this.lagBase) this.lagBase = lag;
    const over = lag - this.lagBase;
    if (over > this.maxLagMs) {
      if (over > 20 && over - this.maxLagMs > 5) this.lateEvents++;
      this.maxLagMs = over;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const inL = input && input.length > 0 ? input[0] : undefined;
    const inR = input && input.length > 1 ? input[1] : inL;
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : output[0];
    const frames = outL.length;
    if (inL) {
      let e = 0;
      for (let i = 0; i < frames; i++) {
        const l = inL[i] * inL[i];
        const r = inR[i] * inR[i];
        e += l > r ? l : r;
      }
      this.energy += e;
    }
    this.frames += frames;
    try {
      if (this.faulted) throw 0;
      this.limiter.process(inL, inR, outL, outR, frames);
      this.monitor.process(inL, inR, outL, outR, frames);
    } catch (e) {
      if (!this.faulted) {
        this.faulted = true;
        this.port.postMessage({ type: "fault", message: String(e) });
      }
      for (let i = 0; i < frames; i++) {
        outL[i] = inL ? inL[i] : 0;
        outR[i] = inR ? inR[i] : 0;
      }
    }
    if (++this.quanta >= REPORT_EVERY) {
      this.checkDeadline();
      const l = this.limiter;
      this.port.postMessage({
        type: "state",
        energy: this.energy / this.frames,
        reductionDb: l.lastReductionDb,
        effectiveBoostDb: l.effectiveBoostDb,
        targetDb: l.targetDb,
        clips: l.clipCount,
        lateEvents: this.lateEvents,
        maxLagMs: this.maxLagMs,
        meters: this.monitor.metersOn ? { ...this.monitor.read(), maxCatchDb: l.readMaxCatchDb() } : null,
      });
      this.quanta = 0;
      this.energy = 0;
      this.frames = 0;
    }
    return true;
  }
}
registerProcessor("uvc-processor", UvcProcessor);
