const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Range } = require("lumine");

describe("typing before completion is prepared", () => {
  let editor, manager, finish, runtime;
  beforeEach(() => {
    runtime = { findSuggestions: jasmine.createSpy("findSuggestions") };
    let row = 1,
      column = 0,
      text = "",
      revision = 0;
    const position = () => ({
      row,
      column,
      isEqual(other) {
        return this.row === other.row && this.column === other.column;
      },
    });
    const mode = {};
    const buffer = {
      getLanguageMode: () => mode,
      getTextRevision: () => revision,
      getPath: () => null,
    };
    const cursor = { getBufferPosition: position };
    editor = {
      getLastCursor: () => cursor,
      getBuffer: () => buffer,
      getGrammar: () => ({}),
      getSelectedBufferRanges: () => [new Range([row, column], [row, column])],
      isReadOnly: () => false,
      isDestroyed: () => false,
      insertText(value) {
        text += value;
        column += value.length;
        manager.didSettleTextInput({
          kind: "insert",
          text: value,
          beforeRevision: revision,
          afterRevision: ++revision,
          changes: [{ oldText: "", newText: value }],
        });
      },
      lineTextForBufferRow: () => text,
      setCursorBufferPosition(point) {
        [row, column] = point;
      },
      destroy() {},
    };
    const isolatedModule = { exports: {} };
    class Preparation {
      constructor(steps) {
        this.promise = new Promise((resolve) => {
          finish = () => {
            for (const step of steps) this.value = step();
            resolve(this.value);
          };
          this.resolve = resolve;
        });
      }
      prepare() {
        return this.promise;
      }
      dispose() {
        finish = () => {};
        this.resolve(null);
      }
    }
    vm.runInNewContext(
      fs.readFileSync(path.join(__dirname, "../lib/autocomplete-manager.js"), "utf8"),
      {
        module: isolatedModule,
        lumine: { grammars: lumine.grammars, workspace: { isTextEditor: () => false } },
        setTimeout,
        clearTimeout,
        console,
        require(request) {
          if (request === "./background-preparation") return Preparation;
          if (request === "./provider-manager")
            return class {
              prepare() {}
            };
          if (request === "./suggestion-list")
            return class {
              changeItems() {}
              hide() {}
            };
          if (request === "./completion-runtime") return runtime;
          if (request.startsWith("./")) return {};
          return require(request);
        },
      },
    );
    manager = new isolatedModule.exports();
    manager.editor = editor;
    manager.buffer = buffer;
    spyOn(manager, "processTextInput");
  });
  afterEach(() => {
    manager.dispose();
    editor.destroy();
  });
  const complete = async () => {
    finish();
    await Promise.resolve();
    await Promise.resolve();
  };

  it("inserts immediately and processes only the latest typed prefix", async () => {
    editor.insertText("a");
    editor.insertText("p");
    expect(editor.lineTextForBufferRow(1)).toBe("ap");
    expect(manager.processTextInput).not.toHaveBeenCalled();
    await complete();
    expect(manager.processTextInput.calls.count()).toBe(1);
  });

  it("does not reopen completion after cancellation", async () => {
    editor.insertText("a");
    manager.cancelSuggestions();
    await complete();
    expect(manager.processTextInput).not.toHaveBeenCalled();
  });

  it("does not reopen completion after losing focus", async () => {
    editor.insertText("a");
    manager.updateCurrentEditor(null);
    await complete();
    expect(manager.processTextInput).not.toHaveBeenCalled();
  });

  it("does not request the old prefix after moving the cursor", async () => {
    editor.insertText("a");
    editor.setCursorBufferPosition([0, 0]);
    await complete();
    expect(manager.processTextInput).not.toHaveBeenCalled();
  });

  it("cancels cold work when the package is disposed", async () => {
    editor.insertText("a");
    manager.dispose();
    await complete();
    expect(manager.processTextInput).not.toHaveBeenCalled();
  });

  it("invalidates a cold manual request immediately when the text changes", async () => {
    const pending = manager.findSuggestions(true);
    editor.insertText("a");
    await complete();
    await pending;
    expect(runtime.findSuggestions).not.toHaveBeenCalled();
    expect(manager.processTextInput.calls.count()).toBe(1);
  });
});
