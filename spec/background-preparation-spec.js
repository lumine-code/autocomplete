const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

describe("background completion preparation", () => {
  let Preparation, tasks, now;
  beforeEach(() => {
    tasks = new Map();
    now = 0;
    let next = 0;
    const isolatedModule = { exports: {} };
    vm.runInNewContext(
      fs.readFileSync(path.join(__dirname, "../lib/background-preparation.js"), "utf8"),
      {
        module: isolatedModule,
        require(request) {
          if (request !== "node:timers") throw new Error(request);
          return {
            setTimeout(callback) {
              tasks.set(++next, callback);
              return next;
            },
            clearTimeout(id) {
              tasks.delete(id);
            },
          };
        },
        performance: { now: () => now },
        requestIdleCallback(callback, options) {
          expect(options.timeout).toBe(100);
          tasks.set(++next, callback);
          return next;
        },
        cancelIdleCallback(id) {
          tasks.delete(id);
        },
      },
    );
    Preparation = isolatedModule.exports;
  });
  const step = (deadline) => {
    const [id, callback] = tasks.entries().next().value;
    tasks.delete(id);
    callback(deadline);
  };

  it("shares preparation and yields between parts without blocking the caller", async () => {
    const calls = [];
    const preparation = new Preparation([
      () => calls.push("load"),
      () => {
        calls.push("construct");
        return "ready";
      },
    ]);
    const first = preparation.prepare();
    expect(preparation.prepare()).toBe(first);
    expect(calls).toEqual([]);
    step();
    expect(calls).toEqual(["load"]);
    expect(preparation.value).toBeNull();
    step();
    expect(await first).toBe("ready");
    expect(preparation.value).toBe("ready");
    expect(tasks.size).toBe(0);
  });

  it("cancels queued construction and settles waiting requests on disposal", async () => {
    let constructed = false;
    const preparation = new Preparation([
      () => {},
      () => {
        constructed = true;
      },
    ]);
    const pending = preparation.prepare();
    step();
    preparation.dispose();
    expect(tasks.size).toBe(0);
    expect(await pending).toBeNull();
    expect(await preparation.prepare()).toBeNull();
    expect(constructed).toBeFalse();
  });

  it("reports failure and retries only the failed part", async () => {
    let loads = 0,
      attempts = 0;
    const preparation = new Preparation([
      () => loads++,
      () => {
        if (++attempts === 1) throw new Error("load failed");
        return "ready";
      },
    ]);
    const failure = preparation.prepare().catch((error) => error.message);
    step();
    step();
    expect(await failure).toBe("load failed");
    const retry = preparation.prepare();
    step();
    expect(await retry).toBe("ready");
    expect(loads).toBe(1);
  });

  it("batches cheap loads but yields once its own allowance is spent", async () => {
    const calls = [];
    const preparation = new Preparation([
      () => {
        calls.push(1);
        now += 2;
      },
      () => {
        calls.push(2);
        now += 2;
      },
      () => {
        calls.push(3);
        return "ready";
      },
    ]);
    const pending = preparation.prepare();
    step({ timeRemaining: () => 50 });
    expect(calls).toEqual([1, 2]);
    step({ timeRemaining: () => 50 });
    expect(await pending).toBe("ready");
    expect(calls).toEqual([1, 2, 3]);
  });

  it("promotes idle preparation for real input without running loaders synchronously", async () => {
    const calls = [];
    const preparation = new Preparation([() => calls.push(1), () => "ready"]);
    const pending = preparation.prepare();
    const idleId = tasks.keys().next().value;
    expect(preparation.prepare(true)).toBe(pending);
    expect(tasks.has(idleId)).toBeFalse();
    expect(tasks.size).toBe(1);
    const taskId = tasks.keys().next().value;
    preparation.prepare(true);
    expect(tasks.has(taskId)).toBeTrue();
    expect(calls).toEqual([]);
    step();
    expect(calls).toEqual([1]);
    expect(preparation.value).toBeNull();
    step();
    expect(await pending).toBe("ready");
  });
});
