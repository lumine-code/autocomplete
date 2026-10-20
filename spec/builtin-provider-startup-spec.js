const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { CompositeDisposable, Disposable } = require("lumine");

describe("the built-in completion provider bootstrap", () => {
  let manager, constructed, suggestions;

  beforeEach(() => {
    constructed = 0;
    suggestions = ["word"];
    const isolatedModule = { exports: {} };
    vm.runInNewContext(
      fs.readFileSync(path.join(__dirname, "../lib/provider-manager.js"), "utf8"),
      {
        module: isolatedModule,
        lumine: {
          config: {
            observe(key, callback) {
              callback(key === "autocomplete.enableBuiltinProvider" ? true : []);
              return new Disposable();
            },
          },
        },
        require: (request) => {
          if (request === "lumine") return { CompositeDisposable, Disposable };
          if (request === "./subsequence-provider") {
            return class {
              constructor() {
                constructed++;
              }
              getSuggestions() {
                return suggestions;
              }
              dispose() {}
            };
          }
          return require(
            request.startsWith(".") ? path.join(__dirname, "../lib", request) : request,
          );
        },
      },
    );
    manager = new isolatedModule.exports();
    manager.initialize();
  });

  afterEach(() => manager.dispose());

  it("registers metadata and retires an unused provider without building its buffer pool", () => {
    expect(manager.defaultProvider.scopeSelector).toBe("*");
    expect(manager.isProviderRegistered(manager.defaultProvider)).toBe(true);
    manager.toggleDefaultProvider(false);
    expect(constructed).toBe(0);
  });

  it("builds the buffer pool once outside the first request and keeps warm requests synchronous", async () => {
    expect(constructed).toBe(0);
    const pending = manager.defaultProvider.getSuggestions({});
    expect(constructed).toBe(0);
    expect(await pending).toBe(suggestions);
    expect(manager.defaultProvider.getSuggestions({})).toBe(suggestions);
    expect(constructed).toBe(1);
  });
  it("does not answer an aborted cold request", async () => {
    const controller = new AbortController();
    const pending = manager.defaultProvider.getSuggestions({ signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual([]);
  });
  it("cancels cold construction on disable and uses the new generation on re-enable", async () => {
    const old = manager.defaultProvider;
    const pending = old.getSuggestions({});
    manager.toggleDefaultProvider(false);
    expect(await pending).toEqual([]);
    expect(constructed).toBe(0);
    manager.toggleDefaultProvider(true);
    expect(await manager.defaultProvider.getSuggestions({})).toBe(suggestions);
    expect(old.getSuggestions({})).toEqual([]);
    expect(constructed).toBe(1);
  });
});
