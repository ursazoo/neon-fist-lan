import { MAX_INPUT_MASK } from './input.js';

export const INPUT_DELAY = 2;
const HISTORY = 120;
const LEAD = 64;

export class Lockstep {
  constructor(player) {
    if (player !== 0 && player !== 1) throw new Error('无效玩家');
    this.player = player;
    this.frame = 0;
    this.inputs = [new Map(), new Map()];
    for (const map of this.inputs) {
      for (let frame = 0; frame < INPUT_DELAY; frame++) map.set(frame, 0);
    }
  }

  put(player, frame, mask) {
    if (!Number.isSafeInteger(frame) || frame < 0 || frame > this.frame + LEAD ||
        !Number.isInteger(mask) || mask < 0 || mask > MAX_INPUT_MASK) {
      throw new Error('输入超出允许范围');
    }
    if (frame < this.frame - HISTORY) throw new Error('输入已过期');
    const map = this.inputs[player];
    if (map.has(frame)) {
      if (map.get(frame) !== mask) throw new Error('同帧输入冲突');
      return false;
    }
    if (frame < this.frame) throw new Error('缺少已执行帧的输入');
    map.set(frame, mask);
    return true;
  }

  capture(sample) {
    const frame = this.frame + INPUT_DELAY;
    if (this.inputs[this.player].has(frame)) return null;
    const mask = typeof sample === 'function' ? sample() : sample;
    this.put(this.player, frame, mask);
    return { frame, mask };
  }

  receive(frame, mask) {
    return this.put(1 - this.player, frame, mask);
  }

  get ready() {
    return this.inputs.every(map => map.has(this.frame));
  }

  advance(step) {
    if (!this.ready) return false;
    step(this.inputs[0].get(this.frame), this.inputs[1].get(this.frame));
    this.frame++;
    for (const map of this.inputs) {
      for (const frame of map.keys()) if (frame < this.frame - HISTORY) map.delete(frame);
    }
    return true;
  }
}
