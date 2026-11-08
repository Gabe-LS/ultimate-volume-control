// K-weighted loudness per ITU-R BS.1770-4, with the filters computed for the actual sample rate.
// No allocation in process().

function kWeighting(sampleRate) {
  // High-shelf stage.
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // High-pass stage.
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + K / Q + K * K;
  const highpass = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return { shelf, highpass };
}

const LUFS_OFFSET = -0.691;
export const energyToLufs = (e) => (e > 0 ? LUFS_OFFSET + 10 * Math.log10(e) : -Infinity);

export class LoudnessMeter {
  constructor(sampleRate, quantum = 128) {
    this.sampleRate = sampleRate;
    this.quantum = quantum;
    const { shelf, highpass } = kWeighting(sampleRate);
    this.s = shelf;
    this.h = highpass;
    this.momentaryQuanta = Math.round((0.4 * sampleRate) / quantum);
    this.shortQuanta = Math.round((3 * sampleRate) / quantum);
    this.ring = new Float64Array(this.shortQuanta);
    // Filter state per channel: shelf z1, z2, high-pass z1, z2.
    this.state = new Float64Array(8);
    this.reset();
  }

  reset() {
    this.state.fill(0);
    this.ring.fill(0);
    this.position = 0;
    this.shortSum = 0;
    this.momentarySum = 0;
    this.filled = 0;
    this.pending = 0;
    this.pendingCount = 0;
    this.maxMomentaryEnergy = 0;
    this.momentaryEnergy = 0;
    this.shortEnergy = 0;
  }

  process(left, right, frames) {
    const { b0: sb0, b1: sb1, b2: sb2, a1: sa1, a2: sa2 } = this.s;
    const { a1: ha1, a2: ha2 } = this.h;
    const st = this.state;
    for (let i = 0; i < frames; i++) {
      let energy = 0;
      for (let c = 0; c < 2; c++) {
        const o = c * 4;
        let x = c === 0 ? left[i] : right ? right[i] : left[i];
        if (!(x >= -1e4 && x <= 1e4)) x = 0;
        const y = sb0 * x + st[o];
        st[o] = sb1 * x - sa1 * y + st[o + 1];
        st[o + 1] = sb2 * x - sa2 * y;
        const z = y + st[o + 2];
        st[o + 2] = -2 * y - ha1 * z + st[o + 3];
        st[o + 3] = y - ha2 * z;
        energy += z * z;
      }
      this.pending += energy;
      if (++this.pendingCount >= this.quantum) this.commit();
    }
  }

  commit() {
    const value = this.pending / this.pendingCount;
    const size = this.ring.length;
    this.shortSum += value - this.ring[this.position];
    this.momentarySum += value - this.ring[(this.position - this.momentaryQuanta + size) % size];
    this.ring[this.position] = value;
    this.position = (this.position + 1) % size;
    if (this.filled < size) this.filled++;
    this.pending = 0;
    this.pendingCount = 0;
    // Summed afresh once per trip round the ring, so that rounding can't build up on a meter that runs for hours.
    if (this.position === 0) {
      let sum = 0;
      let momentary = 0;
      for (let k = 1; k <= this.shortQuanta; k++) {
        sum += this.ring[(this.position - k + size) % size];
        if (k === this.momentaryQuanta) momentary = sum;
      }
      this.shortSum = sum;
      this.momentarySum = momentary;
    }
    // A sum of positive values can't go below zero, except by rounding, and a meter can't read that.
    this.momentaryEnergy = Math.max(0, this.momentarySum) / this.momentaryQuanta;
    this.shortEnergy = Math.max(0, this.shortSum) / this.shortQuanta;
    if (this.momentaryEnergy > this.maxMomentaryEnergy) this.maxMomentaryEnergy = this.momentaryEnergy;
  }

  get momentary() { return energyToLufs(this.momentaryEnergy); }
  get shortTerm() { return energyToLufs(this.shortEnergy); }

  // The value posted at 10 Hz includes the highest momentary reading since the last post.
  readMaxMomentary() {
    const v = energyToLufs(this.maxMomentaryEnergy);
    this.maxMomentaryEnergy = this.momentaryEnergy;
    return v;
  }
}
