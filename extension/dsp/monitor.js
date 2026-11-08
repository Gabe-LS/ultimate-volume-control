// What the popup needs from the audio thread, after the limiter: the meters, and the switch to hear the original.
// Nothing runs and no sample changes until the popup is open.
import { LoudnessMeter } from "./loudness.js";
import { TruePeakDetector, DETECTOR_IN_L, DETECTOR_IN_R, DETECTOR_PEAK } from "./truepeak.js";

const CROSSFADE_SECONDS = 0.02;

// Doubles live here rather than on fields, so that the audio thread doesn't allocate.
const CUR_A = 0, CUR_B = 1, STEP_A = 2, STEP_B = 3, GOAL_A = 4, GOAL_B = 5, PEAK_IN = 6, PEAK_OUT = 7;
const dbOf = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);

export class Monitor {
  constructor(sampleRate, delaySamples) {
    this.delayL = new Float32Array(Math.max(1, delaySamples));
    this.delayR = new Float32Array(Math.max(1, delaySamples));
    this.delayPosition = 0;
    this.fadeSamples = Math.max(1, Math.round(CROSSFADE_SECONDS * sampleRate));
    this.tpIn = new TruePeakDetector();
    this.tpOut = new TruePeakDetector();
    this.loudA = new LoudnessMeter(sampleRate);
    this.loudB = new LoudnessMeter(sampleRate);
    this.s = new Float64Array(8);
    this.s[CUR_B] = this.s[GOAL_B] = 1;
    this.a = { l: new Float32Array(128), r: new Float32Array(128) };
    this.silence = new Float32Array(128);
    this.metersOn = false;
    this.warmup = 0;
    this.original = false;
    this.fading = 0;
  }

  setMeters(on) {
    if (on === this.metersOn) return;
    this.metersOn = on;
    this.tpIn.reset();
    this.tpOut.reset();
    this.s[PEAK_IN] = this.s[PEAK_OUT] = 0;
    // A freshly reset detector sees the signal start from nothing, and its interpolation rings on that step.
    this.warmup = 2 * this.tpIn.taps;
    if (on) {
      this.delayL.fill(0);
      this.delayR.fill(0);
      this.delayPosition = 0;
      this.loudA.reset();
      this.loudB.reset();
    } else {
      this.setOriginal(false); // Closing the popup always returns to the boost.
    }
  }

  // The input, delayed to line up with the limiter's output, at its real level.
  setOriginal(on) {
    if (on === this.original || (on && !this.metersOn)) return;
    this.original = on;
    const s = this.s;
    s[GOAL_A] = on ? 1 : 0;
    s[GOAL_B] = on ? 0 : 1;
    s[STEP_A] = (s[GOAL_A] - s[CUR_A]) / this.fadeSamples;
    s[STEP_B] = (s[GOAL_B] - s[CUR_B]) / this.fadeSamples;
    this.fading = this.fadeSamples;
  }

  // inL and inR are the limiter's input. outL and outR hold its output, and are changed in place when hearing the original.
  process(inL, inR, outL, outR, frames) {
    const s = this.s;
    if (!this.metersOn && this.fading === 0) return;
    if (frames > this.silence.length) {
      this.silence = new Float32Array(frames);
      this.a = { l: new Float32Array(frames), r: new Float32Array(frames) };
    }
    const sourceL = inL || this.silence;
    const sourceR = inR || sourceL;
    const aL = this.a.l, aR = this.a.r, delayL = this.delayL, delayR = this.delayR, size = delayL.length;
    let position = this.delayPosition;
    for (let i = 0; i < frames; i++) {
      aL[i] = delayL[position];
      aR[i] = delayR[position];
      delayL[position] = sourceL[i];
      delayR[position] = sourceR[i];
      position = position + 1 === size ? 0 : position + 1;
    }
    this.delayPosition = position;

    if (this.metersOn) {
      this.loudA.process(aL, aR, frames);
      this.loudB.process(outL, outR, frames);
    }

    if (this.fading > 0 || s[CUR_A] !== 0) {
      let fading = this.fading;
      for (let i = 0; i < frames; i++) {
        if (fading > 0) {
          fading--;
          if (fading === 0) {
            s[CUR_A] = s[GOAL_A];
            s[CUR_B] = s[GOAL_B];
          } else {
            s[CUR_A] += s[STEP_A];
            s[CUR_B] += s[STEP_B];
          }
        }
        outL[i] = aL[i] * s[CUR_A] + outL[i] * s[CUR_B];
        outR[i] = aR[i] * s[CUR_A] + outR[i] * s[CUR_B];
      }
      this.fading = fading;
    }

    if (this.metersOn) {
      const inState = this.tpIn.state, outState = this.tpOut.state;
      let warmup = this.warmup;
      // The meters show the highest peak since the last read, so nothing that can't beat it needs working out.
      this.tpIn.setIgnoreBelow(s[PEAK_IN]);
      this.tpOut.setIgnoreBelow(s[PEAK_OUT]);
      for (let i = 0; i < frames; i++) {
        inState[DETECTOR_IN_L] = sourceL[i];
        inState[DETECTOR_IN_R] = sourceR[i];
        this.tpIn.step();
        outState[DETECTOR_IN_L] = outL[i];
        outState[DETECTOR_IN_R] = outR[i];
        this.tpOut.step();
        if (warmup > 0) {
          warmup--;
          continue;
        }
        if (inState[DETECTOR_PEAK] > s[PEAK_IN]) s[PEAK_IN] = inState[DETECTOR_PEAK];
        if (outState[DETECTOR_PEAK] > s[PEAK_OUT]) s[PEAK_OUT] = outState[DETECTOR_PEAK];
      }
      this.warmup = warmup;
    }
  }

  // Ten times a second at most, and only while the popup is open: this is what may allocate.
  read() {
    const s = this.s;
    const heard = this.original ? this.loudA : this.loudB;
    const other = this.original ? this.loudB : this.loudA;
    const values = {
      peakInDb: dbOf(s[PEAK_IN]),
      peakOutDb: dbOf(s[PEAK_OUT]),
      momentary: heard.readMaxMomentary(),
      shortTerm: heard.shortTerm,
      original: this.original,
    };
    other.readMaxMomentary();
    s[PEAK_IN] = s[PEAK_OUT] = 0;
    return values;
  }

  // Messages from the popup, shared by the worklet and the ScriptProcessor fallback.
  handle(m) {
    if (m.type === "meters") this.setMeters(m.on);
    else if (m.type === "original") this.setOriginal(m.on);
  }
}
