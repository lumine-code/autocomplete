const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Emitter, CompositeDisposable, Disposable } = require("lumine");

describe("completion popup startup", () => {
  it("registers commands without loading popup geometry", () => {
    const isolatedModule = { exports: {} };
    let runtimeLoads = 0;
    let receiver;
    const commands = [];
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../lib/suggestion-list.js"), "utf8"), {
      module: isolatedModule,
      require(request) {
        if (request === "lumine") return { Emitter, CompositeDisposable };
        if (request === "./suggestion-list-runtime") {
          runtimeLoads++;
          return {
            show() {
              receiver = this;
              return "shown";
            },
          };
        }
        throw new Error(`Unexpected popup bootstrap dependency: ${request}`);
      },
      lumine: {
        commands: {
          add(_selector, descriptors) {
            commands.push(...Object.keys(descriptors));
            return new Disposable();
          },
        },
        config: {
          observe(_key, callback) {
            callback(false);
            return new Disposable();
          },
        },
        views: { getView() {} },
      },
    });
    const popup = new isolatedModule.exports();
    popup.initialize();
    popup.hide();
    expect(commands).toContain("autocomplete:confirm");
    expect(runtimeLoads).toBe(0);
    const show = popup.show;
    expect(show()).toBe("shown");
    expect(runtimeLoads).toBe(1);
    expect(receiver).toBe(popup);
    expect(popup.show).toBe(show);
    popup.dispose();
  });
});
