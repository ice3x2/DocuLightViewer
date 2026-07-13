'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const modulePath = path.join(__dirname, '..', 'src', 'main', 'status-coalescer.js');
assert(fs.existsSync(modulePath), 'worker status coalescer is implemented as a testable runtime module');
const { createLatestStatusCoalescer } = require(modulePath);

function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeoutFn(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay, dueAt: now + delay });
      return id;
    },
    clearTimeoutFn(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
    },
    pending() {
      return Array.from(timers.entries()).map(([id, timer]) => ({ id, ...timer }));
    },
    fireDue() {
      const due = Array.from(timers.entries()).filter(([, timer]) => timer.dueAt <= now);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
      }
    }
  };
}

const clock = createFakeClock();
const emitted = [];
const coalescer = createLatestStatusCoalescer({
  emit(value) {
    emitted.push({ value, at: clock.now() });
  },
  intervalMs: 500,
  now: clock.now,
  setTimeoutFn: clock.setTimeoutFn,
  clearTimeoutFn: clock.clearTimeoutFn
});

coalescer.push({ sequence: 0 });
assert.deepStrictEqual(emitted, [{ value: { sequence: 0 }, at: 0 }], 'first status is delivered immediately');

for (let sequence = 1; sequence <= 1000; sequence += 1) {
  coalescer.push({ sequence });
}
assert.strictEqual(emitted.length, 1, '1,000 burst updates do not bypass the 500ms window');
assert.strictEqual(clock.pending().length, 1, 'burst updates share one pending timer');
assert.strictEqual(clock.pending()[0].delay, 500, 'pending burst flush uses the 500ms cadence');

clock.advance(499);
clock.fireDue();
assert.strictEqual(emitted.length, 1, 'status is not emitted before the cadence boundary');
clock.advance(1);
clock.fireDue();
assert.deepStrictEqual(emitted[1], { value: { sequence: 1000 }, at: 500 }, 'cadence boundary emits only the latest burst status');
assert.strictEqual(clock.pending().length, 0, 'timer is consumed after the latest status flush');

clock.advance(100);
coalescer.push({ sequence: 1001 });
assert.strictEqual(clock.pending().length, 1, 'new within-window status schedules one timer');
assert.strictEqual(coalescer.flush(), true, 'terminal flush reports that a pending status was emitted');
assert.deepStrictEqual(emitted[2], { value: { sequence: 1001 }, at: 600 }, 'terminal flush emits pending latest status immediately');
assert.strictEqual(clock.pending().length, 0, 'terminal flush cancels the delayed timer');

coalescer.push({ sequence: 1002 });
assert.strictEqual(clock.pending().length, 1, 'post-flush status schedules a new timer');
coalescer.cancel();
assert.strictEqual(clock.pending().length, 0, 'cancel removes the pending timer');
clock.advance(1000);
clock.fireDue();
assert.strictEqual(emitted.length, 3, 'cancelled pending status is never emitted');

console.log('test-status-coalescer-contract: all assertions passed');
