const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { CompositeDisposable, Disposable } = require("lumine");

describe("provider manager startup", () => {
  it("validates metadata synchronously when a provider is registered", () => {
    const isolatedModule = { exports: {} };
    let metadataLoads = 0;
    vm.runInNewContext(
      fs.readFileSync(path.join(__dirname, "../lib/provider-manager.js"), "utf8"),
      {
        module: isolatedModule,
        require(request) {
          if (request === "lumine") return { CompositeDisposable, Disposable };
          if (request === "./provider-metadata") {
            metadataLoads++;
            return require("../lib/provider-metadata");
          }
          throw new Error(`Unexpected provider bootstrap dependency: ${request}`);
        },
        lumine: {
          notifications: { addError() {} },
          config: {
            observe(_key, callback) {
              callback(false);
              return new Disposable();
            },
          },
        },
        console: { error() {} },
      },
    );
    const manager = new isolatedModule.exports();
    manager.initialize();
    manager.registerProvider({ scopeSelector: "source.js" });
    expect(metadataLoads).toBe(0);
    const provider = { scopeSelector: ".source.js", getSuggestions() {} };
    const registration = manager.registerProvider(provider);
    expect(metadataLoads).toBe(1);
    expect(manager.isProviderRegistered(provider)).toBeTrue();
    expect(manager.metadataForProvider(provider).scopeSelectors.length).toBe(1);
    const unparseable = { scopeSelector: "()", getSuggestions() {} };
    manager.registerProvider(unparseable);
    expect(manager.metadataForProvider(unparseable).scopeSelectors).toEqual([]);
    expect(metadataLoads).toBe(1);
    registration.dispose();
    expect(manager.isProviderRegistered(provider)).toBeFalse();
    manager.dispose();
  });
});
