// True-peak detection by oversampled interpolation of the sidechain. The audio itself is never oversampled.
// No allocation after construction, so it is safe on the audio thread.

function besselI0(x) {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < 1e-18 * sum) break;
  }
  return sum;
}

// Kaiser-windowed sinc, split into phases. Each phase interpolates at n - taps/2 + phase/oversample, and
// phase 0 sits exactly on the input sample because the window is centred on it.
export function designInterpolator(oversample, tapsPerPhase, beta) {
  const length = oversample * tapsPerPhase;
  const centre = length / 2;
  const prototype = new Float64Array(length + 1);
  const denom = besselI0(beta);
  for (let k = 0; k <= length; k++) {
    const t = (k - centre) / oversample;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    const r = (k - centre) / centre;
    prototype[k] = (sinc * besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r)))) / denom;
  }
  const phases = [];
  for (let p = 0; p < oversample; p++) {
    const coefficients = new Float64Array(tapsPerPhase);
    let sum = 0;
    for (let i = 0; i < tapsPerPhase; i++) {
      coefficients[i] = prototype[p + oversample * i];
      sum += coefficients[i];
    }
    for (let i = 0; i < tapsPerPhase; i++) coefficients[i] /= sum;
    phases.push(coefficients);
  }
  return phases;
}

export const DETECTOR_DEFAULTS = { tapsPerPhase: 28, beta: 6 };
const OVERSAMPLE = 4;
// A parabola through three non-negative values, with the middle one highest, peaks at no more than 1.25 times that value.
const REFINE_GAIN = 1.25;

// Per-sample doubles live in this typed array, not on object fields: V8 can allocate when storing a double on a field.
const Y0L = 0, Y1L = 1, Y0R = 2, Y1R = 3, PREVIOUS = 4, PEAK = 5, IN_L = 6, IN_R = 7, GATE = 8, LOW = 9;
export const DETECTOR_PEAK = PEAK, DETECTOR_IN_L = IN_L, DETECTOR_IN_R = IN_R;

export class TruePeakDetector {
  constructor(options = {}) {
    const o = { ...DETECTOR_DEFAULTS, ...options };
    this.taps = o.tapsPerPhase;
    const phases = designInterpolator(OVERSAMPLE, this.taps, o.beta);
    // The filter is symmetric, which leaves far fewer multiplications. Phase 0 is the input sample itself. Phase 2 mirrors
    // itself, and phase 3 mirrors phase 1, so those two follow from one sum over a+b and one over a-b, for a pair of samples
    // a and b equally far from the centre.
    const half = this.taps / 2;
    this.even = new Float64Array(half);
    this.odd = new Float64Array(half);
    this.middle = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      const near = phases[1][i], far = phases[1][this.taps - 1 - i];
      this.even[i] = (near + far) / 2;
      this.odd[i] = (near - far) / 2;
      this.middle[i] = phases[2][i];
    }
    // How far a window of samples can overshoot its largest sample, at the very worst: with every one of them at that level,
    // each with the sign that adds up. Samples further below a level than this can't produce a peak at that level.
    const reach = Math.max(...phases.map((c) => c.reduce((sum, v) => sum + Math.abs(v), 0)));
    this.worstOvershoot = reach * REFINE_GAIN;
    // Whole base samples between an input sample and the peak estimate that covers it.
    this.latency = half;
    this.bufferL = new Float64Array(this.taps * 2);
    this.bufferR = new Float64Array(this.taps * 2);
    this.state = new Float64Array(10);
    this.values = new Float64Array(8);
    this.reset();
  }

  reset() {
    this.bufferL.fill(0);
    this.bufferR.fill(0);
    const gate = this.state[GATE], low = this.state[LOW];
    this.state.fill(0);
    this.state[GATE] = gate;
    this.state[LOW] = low;
    this.write = 0;
    this.open = 0;
    this.clear = true;
  }

  // Peaks below this level don't matter to the caller, so windows that can't reach it aren't worked out, and read as 0.
  // Peaks at or above it come out exactly as they would have. Lowering it mid-signal needs lookAgain() as well.
  setIgnoreBelow(level) {
    this.state[GATE] = level / this.worstOvershoot;
    this.state[LOW] = level / REFINE_GAIN;
  }

  lookAgain() {
    this.open = this.taps + 1;
  }

  // The linked peak around the sample `latency` samples ago, after the last push().
  get peak() {
    return this.state[PEAK];
  }

  // For callers off the audio thread.
  push(left, right) {
    this.state[IN_L] = left;
    this.state[IN_R] = right;
    this.step();
  }

  // Keeps the history up to date, with no peak worked out, for a caller that has no use for one right now.
  // Takes one sample from state[IN_L] and state[IN_R].
  feed() {
    const taps = this.taps;
    const w = this.write;
    const st = this.state;
    const left = st[IN_L], right = st[IN_R], gate = st[GATE];
    this.bufferL[w] = this.bufferL[w + taps] = left;
    this.bufferR[w] = this.bufferR[w + taps] = right;
    this.write = w + 1 === taps ? 0 : w + 1;
    if (left >= gate || left <= -gate || right >= gate || right <= -gate) this.open = taps + 1;
    else if (this.open > 0) this.open--;
    if (!this.clear) {
      st[Y0L] = st[Y1L] = st[Y0R] = st[Y1R] = st[PREVIOUS] = st[PEAK] = 0;
      this.clear = true;
    }
  }

  // Takes one sample from state[IN_L] and state[IN_R], and updates state[PEAK]: the largest interpolated value of either
  // channel in the group before that sample and the group after it, so a peak between two samples protects both.
  // Doubles pass through the typed array because passing or returning one in a call that is not inlined allocates.
  step() {
    const taps = this.taps;
    const w = this.write;
    const bufferL = this.bufferL;
    const bufferR = this.bufferR;
    const st = this.state;
    const left = st[IN_L], right = st[IN_R], gate = st[GATE];
    bufferL[w] = bufferL[w + taps] = left;
    bufferR[w] = bufferR[w + taps] = right;
    const newest = w + taps; // bufferL[newest - i] is the input i samples ago.
    this.write = w + 1 === taps ? 0 : w + 1;

    if (left >= gate || left <= -gate || right >= gate || right <= -gate) this.open = taps + 1;
    if (this.open === 0) {
      // The whole window is quiet, and was for the sample before it.
      if (!this.clear) {
        st[Y0L] = st[Y1L] = st[Y0R] = st[Y1R] = st[PREVIOUS] = st[PEAK] = 0;
        this.clear = true;
      }
      return;
    }
    this.open--;
    this.clear = false;

    const half = taps >> 1;
    const last = newest - taps + 1;
    const even = this.even, odd = this.odd, middle = this.middle;
    let evenL = 0, oddL = 0, middleL = 0, evenR = 0, oddR = 0, middleR = 0;
    for (let i = 0; i < half; i++) {
      const aL = bufferL[newest - i], bL = bufferL[last + i];
      const aR = bufferR[newest - i], bR = bufferR[last + i];
      const sumL = aL + bL, sumR = aR + bR;
      const e = even[i], o = odd[i], m = middle[i];
      evenL += e * sumL;
      oddL += o * (aL - bL);
      middleL += m * sumL;
      evenR += e * sumR;
      oddR += o * (aR - bR);
      middleR += m * sumR;
    }
    const v = this.values;
    v[0] = bufferL[newest - half];
    v[1] = evenL + oddL;
    v[2] = middleL;
    v[3] = evenL - oddL;
    v[4] = bufferR[newest - half];
    v[5] = evenR + oddR;
    v[6] = middleR;
    v[7] = evenR - oddR;

    let y0L = st[Y0L], y1L = st[Y1L], y0R = st[Y0R], y1R = st[Y1R];
    // Every value here and the two before it are low enough that even a parabola through them can't reach what matters.
    const low = st[LOW];
    let highest = y1L > y1R ? y1L : y1R;
    if (y0L > highest) highest = y0L;
    if (y0R > highest) highest = y0R;
    for (let p = 0; p < 8; p++) {
      const value = v[p];
      if (value > highest) highest = value;
      else if (-value > highest) highest = -value;
    }
    if (highest < low) {
      st[Y0L] = v[2] < 0 ? -v[2] : v[2];
      st[Y1L] = v[3] < 0 ? -v[3] : v[3];
      st[Y0R] = v[6] < 0 ? -v[6] : v[6];
      st[Y1R] = v[7] < 0 ? -v[7] : v[7];
      st[PEAK] = highest > st[PREVIOUS] ? highest : st[PREVIOUS];
      st[PREVIOUS] = highest;
      return;
    }
    let group = 0;
    for (let p = 0; p < OVERSAMPLE; p++) {
      let l = v[p];
      let r = v[p + OVERSAMPLE];
      if (l < 0) l = -l;
      if (r < 0) r = -r;
      if (l > group) group = l;
      if (r > group) group = r;
      // Parabola through a local maximum of the oversampled magnitude.
      if (y1L >= y0L && y1L >= l && y1L > 0) {
        const k = y0L - 2 * y1L + l;
        if (k < 0) {
          const peak = y1L - ((l - y0L) * (l - y0L)) / (8 * k);
          if (peak > group) group = peak;
        }
      }
      if (y1R >= y0R && y1R >= r && y1R > 0) {
        const k = y0R - 2 * y1R + r;
        if (k < 0) {
          const peak = y1R - ((r - y0R) * (r - y0R)) / (8 * k);
          if (peak > group) group = peak;
        }
      }
      y0L = y1L; y1L = l;
      y0R = y1R; y1R = r;
    }
    st[Y0L] = y0L; st[Y1L] = y1L; st[Y0R] = y0R; st[Y1R] = y1R;
    st[PEAK] = group > st[PREVIOUS] ? group : st[PREVIOUS];
    st[PREVIOUS] = group;
  }
}
