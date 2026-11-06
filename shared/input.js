export const BTN = Object.freeze({
  LEFT:1, RIGHT:2, UP:4, DOWN:8, PUNCH:16, KICK:32, BLOCK:64,
  FIREBALL:128, UPPERCUT:256, SPIN:512, CLEAR:1024, SUPER:2048,
});
export const MAX_INPUT_MASK = 4095;
const AXES = [BTN.LEFT | BTN.RIGHT, BTN.UP | BTN.DOWN];

export function normalizeMask(mask) {
  mask &= MAX_INPUT_MASK;
  if ((mask & (BTN.LEFT | BTN.RIGHT)) === (BTN.LEFT | BTN.RIGHT)) mask &= ~(BTN.LEFT | BTN.RIGHT);
  if ((mask & (BTN.UP | BTN.DOWN)) === (BTN.UP | BTN.DOWN)) mask &= ~(BTN.UP | BTN.DOWN);
  return mask;
}

export class InputState {
  constructor() {
    this.sources = new Map();
    this.held = 0;
    this.latched = 0;
    this.cancelled = false;
  }
  set(source, mask) {
    const previous = this.held;
    this.sources.set(source, mask & (MAX_INPUT_MASK ^ BTN.CLEAR));
    this.recompute();
    const rising = this.held & ~previous;
    this.latched |= rising;
    for (const axis of AXES) {
      if ((this.held & axis) === axis) this.latched &= ~axis;
      else if (rising & axis) this.latched = (this.latched & ~axis) | (rising & axis);
    }
  }
  remove(source) {
    this.sources.delete(source);
    this.recompute();
  }
  recompute() {
    this.held = 0;
    for (const mask of this.sources.values()) this.held |= mask;
  }
  peek() {
    let mask = this.held | this.latched;
    for (const axis of AXES) {
      if (this.held & axis) mask = (mask & ~axis) | (this.held & axis);
    }
    return normalizeMask(mask) | (this.cancelled ? BTN.CLEAR : 0);
  }
  take() {
    const mask = this.peek();
    this.latched = 0;
    this.cancelled = false;
    return mask;
  }
  clear() {
    this.sources.clear();
    this.held = this.latched = 0;
    this.cancelled = false;
  }
  cancel() { this.clear(); this.cancelled = true; }
}
