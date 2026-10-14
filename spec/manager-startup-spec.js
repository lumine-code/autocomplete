const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { CompositeDisposable, Disposable } = require("lumine");

describe("the autocomplete manager bootstrap", () => {
  it("registers synchronously and loads completion work only for a real request", () => {
    const isolatedModule = { exports: {} };
    const commands = [];
    let runtimeLoads = 0;
    let receiver;
    class ProviderManager {
      initialize() {}
      dispose() {}
    }
    class SuggestionList {
      initialize() {}
      onDidConfirm() {
        return new Disposable();
      }
      onDidCancel() {
        return new Disposable();
      }
      onDidSelect() {
        return new Disposable();
      }
      changeItems() {}
      hide() {}
      dispose() {}
    }
    vm.runInNewContext(
      fs.readFileSync(path.join(__dirname, "../lib/autocomplete-manager.js"), "utf8"),
      {
        module: isolatedModule,
        setTimeout,
        clearTimeout,
        require(request) {
          if (request === "lumine") return { CompositeDisposable, Disposable };
          if (request === "./provider-manager") return ProviderManager;
          if (request === "./suggestion-list") return SuggestionList;
          if (request === "./completion-runtime") {
            runtimeLoads++;
            return {
              findSuggestions() {
                receiver = this;
                return "requested";
              },
              mergeSuggestionsFromProviders: require("../lib/completion-runtime")
                .mergeSuggestionsFromProviders,
            };
          }
          throw new Error(`Unexpected manager bootstrap dependency: ${request}`);
        },
        lumine: {
          config: {
            observe(key, callback) {
              callback(key === "autocomplete.suppressActivationForEditorClasses" ? [] : false);
              return new Disposable();
            },
          },
          commands: {
            add(_selector, descriptors) {
              commands.push(...Object.keys(descriptors));
              return new Disposable();
            },
          },
          workspace: {
            observeTextEditors() {
              return new Disposable();
            },
            observePanes() {
              return new Disposable();
            },
          },
        },
      },
    );
    let manager = new isolatedModule.exports();
    manager.initialize();
    manager.findSuggestions();
    manager.confirm();
    expect(commands).toContain("autocomplete:activate");
    expect(runtimeLoads).toBe(0);
    manager.showOrHideSuggestionListForBufferChanges({ changes: [], origin: "reload" });
    manager.dispose();
    expect(runtimeLoads).toBe(0);
    manager = new isolatedModule.exports();
    manager.initialize();
    manager.editor = {};
    manager.buffer = {};
    const publicRequest = manager.findSuggestions;
    expect(manager.findSuggestions(true)).toBe("requested");
    expect(runtimeLoads).toBe(1);
    expect(receiver).toBe(manager);
    expect(manager.findSuggestions).toBe(publicRequest);
    const unboundMerge = manager.mergeSuggestionsFromProviders;
    const suggestion = { text: "value" };
    expect(unboundMerge([null, [suggestion], []])).toEqual([suggestion]);
    manager.dispose();
  });
});
