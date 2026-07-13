'use strict';

// @req REL-DOC-007
function createLatestStatusCoalescer({ emit, intervalMs = 500, now, setTimeoutFn, clearTimeoutFn } = {}) {
  if (typeof emit !== 'function') throw new TypeError('Status coalescer requires an emit function');
  const cadenceMs = Math.max(1, Number(intervalMs) || 500);
  const nowFn = typeof now === 'function' ? now : Date.now;
  const schedule = setTimeoutFn || setTimeout;
  const cancelTimer = clearTimeoutFn || clearTimeout;
  let lastEmittedAt = null;
  let pendingValue;
  let hasPendingValue = false;
  let timer = null;

  function clearScheduledFlush() {
    if (timer === null) return;
    cancelTimer(timer);
    timer = null;
  }

  function flush() {
    clearScheduledFlush();
    if (!hasPendingValue) return false;
    const value = pendingValue;
    pendingValue = undefined;
    hasPendingValue = false;
    lastEmittedAt = nowFn();
    emit(value);
    return true;
  }

  function scheduleFlush(delayMs) {
    if (timer !== null) return;
    timer = schedule(() => {
      timer = null;
      flush();
    }, Math.max(0, delayMs));
  }

  function push(value) {
    pendingValue = value;
    hasPendingValue = true;
    const currentTime = nowFn();
    if (lastEmittedAt === null || currentTime - lastEmittedAt >= cadenceMs) {
      flush();
      return;
    }
    scheduleFlush(cadenceMs - (currentTime - lastEmittedAt));
  }

  function cancel() {
    clearScheduledFlush();
    pendingValue = undefined;
    hasPendingValue = false;
  }

  return { push, flush, cancel };
}

module.exports = { createLatestStatusCoalescer };
