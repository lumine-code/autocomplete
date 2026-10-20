const { TextBuffer, TextEditor, Disposable } = require("lumine");
const { Readable } = require("stream");
require("./spec-helper");

describe("Autocomplete during file reload", () => {
  let source, signalChange, buffer, editor, editorView, manager, provider, registration;

  const latestCompletion = () => manager.findSuggestions.calls.mostRecent().returnValue;
  const expectClosed = () => {
    expect(manager.suggestionList.isActive()).toBe(false);
    expect(editorView.classList.contains("autocomplete-active")).toBe(false);
    expect(editorView.querySelector(".autocomplete")).not.toExist();
  };
  const changeSource = async (text) => {
    const reloaded = new Promise((resolve) => {
      const subscription = buffer.onDidReload(() => {
        subscription.dispose();
        resolve();
      });
    });
    source.text = text;
    signalChange();
    await reloaded;
  };
  const activate = () => {
    lumine.commands.dispatch(editorView, "autocomplete:activate");
    return latestCompletion();
  };

  beforeEach(async () => {
    jasmine.useRealClock();
    lumine.config.set("autocomplete.enableAutoActivation", true);
    lumine.config.set("autocomplete.autoActivationDelay", 0);
    lumine.config.set("autocomplete.enableAutoConfirmSingleSuggestion", false);
    lumine.config.set("autocomplete.commitCharacters", false);
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    source = {
      text: "header\nca",
      getPath: () => null,
      existsSync: () => true,
      createReadStream() {
        return Readable.from([this.text]);
      },
      onDidChange(callback) {
        signalChange = callback;
        return new Disposable();
      },
    };
    buffer = await TextBuffer.load(source);
    buffer.fileChangeDelay = 0;
    editor = new TextEditor({ buffer });
    await lumine.workspace.open(editor);
    editor.setCursorBufferPosition([1, 2]);
    editorView = lumine.views.getView(editor);
    const pack = await lumine.packages.activatePackage("autocomplete");
    manager = pack.mainModule.autocompleteManager;
    // These specs exercise requests after preparation; cold input has its own suite.
    await manager.prepareCompletion();
    editorView.focus();
    expect(manager.editor).toBe(editor);
    provider = {
      scopeSelector: "*",
      inclusionPriority: 2,
      excludeLowerPriority: true,
      getSuggestions() {
        return [{ text: "cable" }, { text: "cabinet" }];
      },
    };
    spyOn(provider, "getSuggestions").and.callThrough();
    registration = pack.mainModule.consumeAutocomplete(provider);
    spyOn(manager, "findSuggestions").and.callThrough();
  });

  afterEach(() => {
    manager.cancelSuggestions();
    registration.dispose();
    editor.destroy();
  });

  for (const { description, text } of [
    { description: "inserts a letter", text: "header\ncab" },
    { description: "replaces a letter", text: "header\ncb" },
    { description: "inserts a space", text: "header\nca " },
    { description: "inserts a bracket pair", text: "header\nca()" },
  ]) {
    it(`keeps completion closed when a clean watched source ${description} at the cursor`, async () => {
      await changeSource(text);

      expect(editor.getText()).toBe(text);
      expect(buffer.getFileState()).toBe("unmodified");
      expect(provider.getSuggestions).not.toHaveBeenCalled();
      expectClosed();
    });
  }

  it("does not interpret an external deletion as backspace", async () => {
    lumine.config.set("autocomplete.backspaceTriggersAutocomplete", true);

    await changeSource("header\nc");

    expect(provider.getSuggestions).not.toHaveBeenCalled();
    expectClosed();
  });

  it("ignores an external provider trigger and still completes subsequent typing", async () => {
    lumine.config.set("autocomplete.enableAutoActivation", false);
    provider.triggerCharacters = new Set(["."]);

    await changeSource("header\nca.");

    expect(provider.getSuggestions).not.toHaveBeenCalled();
    expectClosed();

    lumine.config.set("autocomplete.enableAutoActivation", true);
    editor.insertText("c");
    await latestCompletion();

    expect(provider.getSuggestions.calls.count()).toBe(1);
    expect(manager.suggestionList.isActive()).toBe(true);
  });

  it("discards a pending response when the watched source changes away from the cursor", async () => {
    let resolveSuggestions;
    provider.getSuggestions.and.callFake(
      () => new Promise((resolve) => (resolveSuggestions = resolve)),
    );
    const completion = activate();

    await changeSource("new header\nca");
    expect(manager.currentSuggestionsPromise).toBeNull();
    resolveSuggestions([{ text: "cable" }]);
    await completion;

    expect(provider.getSuggestions.calls.count()).toBe(1);
    expectClosed();
  });

  it("closes a visible list when the watched source changes away from the cursor", async () => {
    await activate();
    expect(manager.suggestionList.isActive()).toBe(true);

    await changeSource("new header\nca");

    expect(provider.getSuggestions.calls.count()).toBe(1);
    expectClosed();
  });

  it("does not accept a commit character from the watched source or modify its content", async () => {
    lumine.config.set("autocomplete.commitCharacters", true);
    provider.getSuggestions.and.returnValue([
      { text: "cable", commitCharacters: ["("] },
      { text: "cabinet", commitCharacters: ["("] },
    ]);
    await activate();
    expect(manager.suggestionList.isActive()).toBe(true);
    spyOn(manager, "confirmWithCommitCharacter").and.callThrough();

    await changeSource("header\nca(");

    expect(manager.confirmWithCommitCharacter).not.toHaveBeenCalled();
    expect(editor.getText()).toBe(source.text);
    expect(buffer.getFileState()).toBe("unmodified");
    expectClosed();

    await activate();
    expect(provider.getSuggestions.calls.count()).toBe(2);
    expect(manager.suggestionList.isActive()).toBe(true);
  });

  it("cancels a pending response even when an explicit reload has no text changes", async () => {
    let resolveSuggestions;
    provider.getSuggestions.and.callFake(
      () => new Promise((resolve) => (resolveSuggestions = resolve)),
    );
    const completion = activate();

    await buffer.reload();
    expect(manager.currentSuggestionsPromise).toBeNull();
    resolveSuggestions([{ text: "cable" }]);
    await completion;

    expect(provider.getSuggestions.calls.count()).toBe(1);
    expectClosed();
  });
});
