(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.createSettingsStatusPoller = api.createSettingsStatusPoller;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // @req REL-DOC-007
  // @req REL-DOC-008
  function createSettingsStatusPoller(options = {}) {
    const refreshIndexingStatus = options.refreshIndexingStatus;
    const refreshEmbeddingStatus = options.refreshEmbeddingStatus;
    const isActive = typeof options.isActive === 'function' ? options.isActive : () => false;
    const activeDelayMs = Math.max(0, Number(options.activeDelayMs) || 500);
    const idleDelayMs = Math.max(activeDelayMs, Number(options.idleDelayMs) || 3000);
    const setTimeoutFn = options.setTimeoutFn || setTimeout;
    const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
    if (typeof refreshIndexingStatus !== 'function' || typeof refreshEmbeddingStatus !== 'function') {
      throw new TypeError('Settings status poller requires indexing and embedding refresh functions');
    }

    let running = false;
    let timer = null;
    let cyclePromise = null;
    let lastIndexingStatus = null;

    function clearScheduledTimer() {
      if (timer === null) return;
      clearTimeoutFn(timer);
      timer = null;
    }

    function scheduleNextCycle() {
      if (!running) return;
      clearScheduledTimer();
      const delay = isActive(lastIndexingStatus) ? activeDelayMs : idleDelayMs;
      timer = setTimeoutFn(() => {
        timer = null;
        return pollNow();
      }, delay);
    }

    function callRefresh(refresh) {
      try {
        return Promise.resolve(refresh());
      } catch (err) {
        return Promise.reject(err);
      }
    }

    function pollNow() {
      if (!running) return Promise.resolve(null);
      if (cyclePromise) return cyclePromise;
      const indexingPromise = callRefresh(refreshIndexingStatus);
      const embeddingPromise = callRefresh(refreshEmbeddingStatus);
      cyclePromise = Promise.allSettled([indexingPromise, embeddingPromise])
        .then((outcomes) => {
          const indexingOutcome = outcomes[0];
          if (indexingOutcome && indexingOutcome.status === 'fulfilled' && indexingOutcome.value) {
            lastIndexingStatus = indexingOutcome.value;
          }
          return outcomes;
        })
        .finally(() => {
          cyclePromise = null;
          scheduleNextCycle();
        });
      return cyclePromise;
    }

    function start() {
      if (!running) running = true;
      return pollNow();
    }

    function stop() {
      running = false;
      clearScheduledTimer();
    }

    return {
      start,
      stop,
      pollNow,
      getState() {
        return {
          running,
          inFlight: Boolean(cyclePromise),
          timerScheduled: timer !== null,
          lastIndexingStatus
        };
      }
    };
  }

  return { createSettingsStatusPoller };
});
