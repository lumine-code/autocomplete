// Use up to 4 ms of an idle turn, yielding between module loads. An individual
// CommonJS load cannot be interrupted. The timeout also advances busy/hidden
// windows; a cold request never runs a loader in the input handler itself.
const { setTimeout: scheduleTask, clearTimeout: cancelTask } = require("node:timers");

module.exports = class BackgroundPreparation {
  constructor(steps) {
    this.steps = steps;
    this.index = 0;
    this.value = null;
  }

  prepare(urgent = false) {
    if (this.disposed) return Promise.resolve(null);
    if (urgent && !this.urgent) {
      this.urgent = true;
      // A real request must not wait behind idle timeouts. Keep it outside
      // the input stack, with a task boundary between each remaining load.
      if (this.cancel) {
        this.cancel();
        this.schedule();
      }
    }
    if (this.promise) return this.promise;
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      const run = (deadline) => {
        this.cancel = null;
        try {
          const start = performance.now();
          do {
            const value = this.steps[this.index]();
            this.index++;
            if (this.index === this.steps.length) {
              this.value = value;
              this.steps = null;
              this.schedule = null;
              resolve(value);
              return;
            }
          } while (performance.now() - start < 4 && deadline?.timeRemaining() > 0);
          this.schedule();
        } catch (error) {
          this.promise = null;
          this.schedule = null;
          reject(error);
        }
      };
      this.schedule = () => {
        if (!this.urgent && typeof requestIdleCallback === "function") {
          const id = requestIdleCallback(run, { timeout: 100 });
          this.cancel = () => cancelIdleCallback(id);
        } else {
          const id = scheduleTask(run, 0);
          this.cancel = () => cancelTask(id);
        }
      };
      this.schedule();
    });
    return this.promise;
  }

  dispose() {
    this.disposed = true;
    this.cancel?.();
    this.cancel = null;
    this.steps = null;
    this.schedule = null;
    this.resolve?.(null);
  }
};
