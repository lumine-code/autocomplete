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

  it("builds the buffer pool once when completion is actually requested", () => {
    expect(constructed).toBe(0);
    expect(manager.defaultProvider.getSuggestions({})).toBe(suggestions);
    expect(manager.defaultProvider.getSuggestions({})).toBe(suggestions);
    expect(constructed).toBe(1);
  });
});
