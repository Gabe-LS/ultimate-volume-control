// Boost and true-peak limiter. Pure DSP with no browser or extension dependency, and no allocation in process().
//
// Signal path: input -> smoothed gain -> [sidechain true-peak detector] and [look-ahead delay] -> gain reduction -> clipper.
//
// Delay proof. Required gain flows: req -> sliding minimum over M samples -> moving average over N samples, with M >= N.
// Every sliding-minimum window inside the moving average contains the sample at n-N+1, so the output gain at n cannot
// exceed the required gain of n-N+1. req(n) describes the input at n-L, where L is the detector latency. The audio delay
// D = N-1+L therefore puts each sample under a gain no higher than its own requirement. This bounds gain against detected
// peaks. The reconstructed output ceiling is a tested property, because interpolation does not commute with varying gain.

import { TruePeakDetector, DETECTOR_DEFAULTS, DETECTOR_PEAK, DETECTOR_IN_L, DETECTOR_IN_R } from "./truepeak.js";

export const LIMITER_DEFAULTS = {
  ceilingDb: 0, // dBTP
  marginDb: 0.2, // Subtracted from the ceiling inside the gain computer: covers detector error.
  lookaheadSeconds: 0.005,
  holdSeconds: 0.025,
  catchReleaseSeconds: 0.1,
  gainRampSeconds: 0.03,
  budgetDb: 1, // Peak catching the boost stage leaves to the limiter: the dynamics budget.
  hitWindowSeconds: 3,
  hitSeparationSeconds: 0.2,
  blockSeconds: 0.05,
  lowerRampSeconds: 5,
  restoreRampSeconds: 0.03,
  detector: DETECTOR_DEFAULTS,
};

const MAX_TARGET_DB = 20 * Math.log10(4); // The slider's 400%, exactly.
const dbToLinear = (db) => Math.pow(10, db / 20);

export class Limiter {
  constructor(sampleRate, options = {}) {
    const o = { ...LIMITER_DEFAULTS, ...options };
    this.sampleRate = sampleRate;
    this.detector = new TruePeakDetector(o.detector);
    this.budgetDb = o.budgetDb;
    this.marginDb = o.marginDb;

    this.N = Math.ceil(o.lookaheadSeconds * sampleRate);
    this.M = Math.max(this.N, Math.round(o.holdSeconds * sampleRate));
    this.D = this.N - 1 + this.detector.latency;
    this.latencySamples = this.D;

    // Read before write, so a ring of D slots delays by exactly D samples.
    this.delayL = new Float32Array(this.D);
    this.delayR = new Float32Array(this.D);
    // The gain each delayed sample was scaled with, so the reduction applied to it never exceeds its own boost.
    this.gainDelay = new Float64Array(this.D);

    // Sliding minimum, as a monotonic queue over preallocated rings.
    this.minValues = new Float64Array(this.M);
    this.minIndex = new Float64Array(this.M);
    // Moving average.
    this.average = new Float64Array(this.N);

    this.catchCoefficient = Math.exp(-1 / (o.catchReleaseSeconds * sampleRate));
    this.gainRampSamples = Math.max(1, Math.round(o.gainRampSeconds * sampleRate));
    this.restoreRampSamples = Math.max(1, Math.round(o.restoreRampSeconds * sampleRate));
    this.lowerRampSamples = Math.max(1, Math.round(o.lowerRampSeconds * sampleRate));
    // Long enough for the last reduction to have left the moving average.
    this.passAfterSamples = this.N;

    // Boost stage memory: the worst required reduction per block, over the hit window.
    this.blockSize = Math.max(1, Math.round(o.blockSeconds * sampleRate));
    this.blockCount = Math.round(o.hitWindowSeconds / o.blockSeconds);
    this.hitGuard = Math.round(o.hitSeparationSeconds / o.blockSeconds);
    this.blocks = new Float64Array(this.blockCount);
    this.scratch = new Float64Array(1);

    this.setCeilingDb(o.ceilingDb);
    this.targetDb = 0;
    this.gain = 1;
    this.gainDb = 0;
    this.gainGoal = 1;
    this.gainStep = 0;
    this.gainSteps = 0;
    this.resetState();
  }

  resetState() {
    this.detector.reset();
    this.delayL.fill(0);
    this.delayR.fill(0);
    this.gainDelay.fill(1);
    this.delayPosition = 0;
    this.count = 0;
    this.minHead = 0;
    this.minSize = 0;
    this.average.fill(1);
    this.averagePosition = 0;
    this.averageSum = this.N;
    this.sinceRecompute = 0;
    this.catchDb = 0;
    this.clearBoostMemory();
    this.boostDb = 0;
    this.boostStep = 0;
    this.restoring = false;
    this.lastGain = 1;
    this.unreducedFor = 0;
    this.lastReductionDb = 0;
    this.maxReductionDb = 0;
    this.maxCatchDb = 0;
    this.clipCount = 0;
  }

  clearBoostMemory() {
    this.blocks.fill(0);
    this.blockWrite = 0;
    this.blockPeak = 0;
    this.blockFill = 0;
    this.boostGoalDb = 0;
  }

  setCeilingDb(db) {
    this.ceilingDb = db;
    this.thresholdLinear = dbToLinear(db - this.marginDb);
    // Only a peak over the threshold changes anything, so the detector needn't work out the rest.
    this.detector.setIgnoreBelow(this.thresholdLinear);
    this.detector.lookAgain();
  }

  // The slider. Raising it is the user asking for the boost back, so it clears what the limiter has learned.
  // Lowering it keeps the boost already earned down, up to the new setting.
  // rampSeconds overrides the normal slider ramp: a newly attached graph comes in more gently.
  setTargetDb(db, rampSeconds) {
    const next = Math.min(MAX_TARGET_DB, Math.max(0, db));
    if (next > this.targetDb) {
      this.restoreBoost();
    } else if (next < this.targetDb) {
      const effective = this.targetDb - this.boostDb;
      const lowered = Math.max(0, next - effective);
      const goal = Math.min(this.boostGoalDb, lowered);
      // What the memory holds was measured at the higher gain and no longer applies. Left in place, it would lower the
      // new setting for no reason, down to no boost at all.
      this.clearBoostMemory();
      this.boostGoalDb = goal;
      this.boostDb = Math.min(this.boostDb, lowered);
    }
    this.targetDb = next;
    this.gainGoal = dbToLinear(next);
    const steps = rampSeconds > 0 ? Math.max(1, Math.round(rampSeconds * this.sampleRate)) : this.gainRampSamples;
    this.gainSteps = steps;
    this.gainStep = (this.gainGoal - this.gain) / steps;
  }

  // New page or new source: forget the lowered boost and return to the slider value.
  restoreBoost() {
    this.clearBoostMemory();
    this.restoring = this.boostDb > 0;
    this.boostStep = this.boostDb / this.restoreRampSamples;
  }

  // The boost actually in force, once the limiter's learning is taken off the slider value.
  get effectiveBoostDb() {
    return this.targetDb - this.boostDb;
  }

  // Only the peaks caught right now, without what the boost has already lowered itself by.
  readMaxCatchDb() {
    const v = this.maxCatchDb;
    this.maxCatchDb = 0;
    return v;
  }

  readMaxReductionDb() {
    const v = this.maxReductionDb;
    this.maxReductionDb = 0;
    return v;
  }

  // Second-worst block in the window, with blocks too close to the worst one excluded so that one event counts once.
  // The result goes to a typed array, for the same reason as in TruePeakDetector.push().
  // Distances are in time: oldest is the next slot to be written, so the oldest and newest blocks are far apart, not adjacent.
  updateSecondWorst(oldest) {
    const blocks = this.blocks;
    const n = this.blockCount;
    let worst = -1;
    let worstAt = 0;
    for (let i = 0; i < n; i++) {
      if (blocks[i] > worst) { worst = blocks[i]; worstAt = i; }
    }
    let second = 0;
    const guard = this.hitGuard;
    for (let i = 0; i < n; i++) {
      const distance = Math.abs(((i - oldest + n) % n) - ((worstAt - oldest + n) % n));
      if (distance > guard && blocks[i] > second) second = blocks[i];
    }
    this.scratch[0] = second;
  }

  // At exactly 100%, with nothing left to release, a peak can't change anything: the reduction is capped at the boost, and
  // the boost is nothing. The samples only have to go through the delay, and the detector only has to remember them for when
  // the slider next moves. Reduction state stays as it is, since all of it is at rest.
  passThrough(inL, inR, outL, outR, frames) {
    const haveL = inL && inL.length > 0;
    const haveR = inR && inR.length > 0;
    const delayL = this.delayL;
    const delayR = this.delayR;
    const gainDelay = this.gainDelay;
    const delaySize = this.D;
    const detector = this.detector;
    const st = detector.state;
    let position = this.delayPosition;
    for (let i = 0; i < frames; i++) {
      const rawL = haveL ? inL[i] : haveR ? inR[i] : 0;
      const rawR = haveR ? inR[i] : haveL ? inL[i] : 0;
      const left = rawL >= -1e4 && rawL <= 1e4 && (rawL > 1e-20 || rawL < -1e-20) ? rawL : 0;
      const right = rawR >= -1e4 && rawR <= 1e4 && (rawR > 1e-20 || rawR < -1e-20) ? rawR : 0;
      st[DETECTOR_IN_L] = left;
      st[DETECTOR_IN_R] = right;
      detector.feed();
      outL[i] = delayL[position];
      outR[i] = delayR[position];
      delayL[position] = left;
      delayR[position] = right;
      gainDelay[position] = 1;
      position = position + 1 === delaySize ? 0 : position + 1;
    }
    this.delayPosition = position;
  }

  // Doubles are held in locals during the loop and stored on fields once per block: storing a double on a field per
  // sample allocates, and the audio thread must not cause garbage collection.
  process(inL, inR, outL, outR, frames) {
    if (this.targetDb === 0 && this.gain === 1 && this.gainSteps === 0 && this.boostDb === 0 && this.boostGoalDb === 0 && !this.restoring
      && this.catchDb === 0 && this.unreducedFor >= this.passAfterSamples) {
      this.passThrough(inL, inR, outL, outR, frames);
      return;
    }
    const delayL = this.delayL;
    const delayR = this.delayR;
    const gainDelay = this.gainDelay;
    const delaySize = this.D;
    const M = this.M;
    const N = this.N;
    const minValues = this.minValues;
    const minIndex = this.minIndex;
    const average = this.average;
    const threshold = this.thresholdLinear;
    const detector = this.detector;
    const detectorState = detector.state;
    const blocks = this.blocks;
    const scratch = this.scratch;
    const haveL = inL && inL.length > 0;
    const haveR = inR && inR.length > 0;
    const catchCoefficient = this.catchCoefficient;
    const budgetDb = this.budgetDb;
    const blockSize = this.blockSize;
    const blockCount = this.blockCount;
    const lowerRampSamples = this.lowerRampSamples;
    const gainGoal = this.gainGoal;
    const gainStep = this.gainStep;

    let gain = this.gain;
    let gainDb = this.gainDb;
    let gainSteps = this.gainSteps;
    let blockPeak = this.blockPeak;
    let blockFill = this.blockFill;
    let blockWrite = this.blockWrite;
    let boostDb = this.boostDb;
    let boostGoalDb = this.boostGoalDb;
    let boostStep = this.boostStep;
    let restoring = this.restoring;
    let catchDb = this.catchDb;
    let maxReductionDb = this.maxReductionDb;
    let maxCatchDb = this.maxCatchDb;
    let lastGain = this.lastGain;
    let lastTotal = this.lastReductionDb;
    let count = this.count;
    let size = this.minSize;
    let head = this.minHead;
    let averageSum = this.averageSum;
    let averagePosition = this.averagePosition;
    let sinceRecompute = this.sinceRecompute;
    let delayPosition = this.delayPosition;
    let clipCount = this.clipCount;

    for (let i = 0; i < frames; i++) {
      if (gainSteps > 0) {
        gainSteps--;
        gain = gainSteps === 0 ? gainGoal : gain + gainStep;
        gainDb = 20 * Math.log10(gain);
      }
      const rawL = haveL ? inL[i] : haveR ? inR[i] : 0;
      const rawR = haveR ? inR[i] : haveL ? inL[i] : 0;
      // NaN, Inf and denormals become silence.
      const left = (rawL >= -1e4 && rawL <= 1e4 && (rawL > 1e-20 || rawL < -1e-20) ? rawL : 0) * gain;
      const right = (rawR >= -1e4 && rawR <= 1e4 && (rawR > 1e-20 || rawR < -1e-20) ? rawR : 0) * gain;

      // Required reduction, capped at the boost itself: this is what keeps the output from ever falling below 100%.
      detectorState[DETECTOR_IN_L] = left;
      detectorState[DETECTOR_IN_R] = right;
      detector.step();
      const peak = detectorState[DETECTOR_PEAK];
      let required = 0;
      if (peak > threshold) {
        required = 20 * Math.log10(peak / threshold);
        if (required > gainDb) required = gainDb;
      }

      // Boost stage: lowering only. It reacts to repeated hits, and never rises by itself.
      // While the slider is coming down, the gain is still above the new setting, so these readings don't count either.
      if (required > blockPeak && !(gainSteps > 0 && gainStep < 0)) blockPeak = required;
      if (++blockFill >= blockSize) {
        blocks[blockWrite] = blockPeak;
        blockWrite = blockWrite + 1 === blockCount ? 0 : blockWrite + 1;
        blockPeak = 0;
        blockFill = 0;
        this.updateSecondWorst(blockWrite);
        const goal = scratch[0] - budgetDb;
        if (goal > boostGoalDb) {
          boostGoalDb = goal;
          boostStep = (goal - boostDb) / lowerRampSamples;
          restoring = false;
        }
      }
      if (restoring) {
        boostDb -= boostStep;
        if (boostDb <= 0) { boostDb = 0; restoring = false; }
      } else if (boostDb < boostGoalDb) {
        boostDb += boostStep;
        if (boostDb > boostGoalDb) boostDb = boostGoalDb;
      }

      // Peak catch: instant attack, exponential release, on top of the boost stage.
      const need = required - boostDb;
      const decayed = catchDb * catchCoefficient;
      catchDb = need > decayed ? need : decayed;
      if (catchDb < 1e-9) catchDb = 0;
      let total = boostDb + catchDb;
      if (total > gainDb) total = gainDb;

      if (total !== lastTotal) {
        lastGain = total > 0 ? Math.pow(10, -total / 20) : 1;
        lastTotal = total;
      }
      if (total > maxReductionDb) maxReductionDb = total;
      if (total - boostDb > maxCatchDb) maxCatchDb = total - boostDb;

      // Sliding minimum over M samples. Expire before inserting: on a smooth recovery the queue is full, and inserting
      // first would overwrite its head.
      const n = count++;
      if (size > 0 && minIndex[head] <= n - M) { head = head + 1 === M ? 0 : head + 1; size--; }
      while (size > 0 && minValues[(head + size - 1) % M] >= lastGain) size--;
      const slot = (head + size) % M;
      minValues[slot] = lastGain;
      minIndex[slot] = n;
      size++;
      const held = minValues[head];

      // Moving average over N samples. The sum is rebuilt now and then so that rounding cannot accumulate.
      averageSum += held - average[averagePosition];
      average[averagePosition] = held;
      averagePosition = averagePosition + 1 === N ? 0 : averagePosition + 1;
      if (++sinceRecompute >= 65536) {
        let sum = 0;
        for (let k = 0; k < N; k++) sum += average[k];
        averageSum = sum;
        sinceRecompute = 0;
      }
      let envelope = averageSum / N;
      if (envelope > 1 - 1e-12) envelope = 1;

      // Look-ahead delay.
      const delayedL = delayL[delayPosition];
      const delayedR = delayR[delayPosition];
      const delayedGain = gainDelay[delayPosition];
      delayL[delayPosition] = left;
      delayR[delayPosition] = right;
      gainDelay[delayPosition] = gain;
      delayPosition = delayPosition + 1 === delaySize ? 0 : delayPosition + 1;
      // The reduction was capped at the boost when it was worked out, but the hold and the average carry it onto samples
      // scaled with a different gain while the slider moves. Never below the source: at 100% this makes it exactly 1.
      if (envelope * delayedGain < 1) envelope = 1 / delayedGain;

      let oL = delayedL * envelope;
      let oR = delayedR * envelope;
      // Emergency only, and never on an exact bypass, so 100% stays bit-identical apart from the delay.
      if (gain !== 1 || envelope !== 1) {
        if (oL > 1) { oL = 1; clipCount++; } else if (oL < -1) { oL = -1; clipCount++; }
        if (oR > 1) { oR = 1; clipCount++; } else if (oR < -1) { oR = -1; clipCount++; }
      }
      outL[i] = oL;
      outR[i] = oR;
    }

    this.gain = gain;
    this.gainDb = gainDb;
    this.gainSteps = gainSteps;
    this.blockPeak = blockPeak;
    this.blockFill = blockFill;
    this.blockWrite = blockWrite;
    this.boostDb = boostDb;
    this.boostGoalDb = boostGoalDb;
    this.boostStep = boostStep;
    this.restoring = restoring;
    this.catchDb = catchDb;
    this.maxReductionDb = maxReductionDb;
    this.maxCatchDb = maxCatchDb;
    this.lastGain = lastGain;
    this.lastReductionDb = lastTotal;
    // One value in the queue, of 1, means no reduction for the whole window. A dip stays in the queue for longer than a block.
    this.unreducedFor = size === 1 && minValues[head] === 1 ? this.unreducedFor + frames : 0;
    this.count = count;
    this.minSize = size;
    this.minHead = head;
    this.averageSum = averageSum;
    this.averagePosition = averagePosition;
    this.sinceRecompute = sinceRecompute;
    this.delayPosition = delayPosition;
    this.clipCount = clipCount;
  }
}
