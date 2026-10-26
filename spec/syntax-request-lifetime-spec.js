require("./spec-helper");

describe("Autocomplete syntax request lifetime", () => {
  let editor, manager, registration, release, epoch, mode;
  beforeEach(async () => {
    const textGrammarPackage = await lumine.packages.activatePackage("language-text");
    await textGrammarPackage.resourceLoadPromise;
    jasmine.useRealClock();
    lumine.config.set("autocomplete.enableAutoActivation", false);
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    await lumine.packages.activatePackage("language-javascript");
    editor = await lumine.workspace.open();
    editor.setText("c");
    lumine.grammars.assignLanguageMode(editor.getBuffer(), "source.js");
    await editor.whenGrammarSettled();
    mode = editor.getBuffer().getLanguageMode();
    epoch = 1;
    spyOn(
      mode,
      mode.getSyntaxRequestEpoch ? "getSyntaxRequestEpoch" : "getSyntaxGeneration",
    ).and.callFake(() => epoch);
    const pack = await lumine.packages.activatePackage("autocomplete");
    manager = pack.mainModule.autocompleteManager;
    await manager.prepareCompletion();
    lumine.views.getView(editor).focus();
    editor.setCursorBufferPosition([0, 1]);
    manager.cancelSuggestions();
    registration = pack.mainModule.consumeAutocomplete({
      scopeSelector: "*",
      inclusionPriority: 10,
      excludeLowerPriority: true,
      getSuggestions: () => new Promise((resolve) => (release = resolve)),
    });
  });
  afterEach(() => {
    release?.([]);
    manager.cancelSuggestions();
    registration.dispose();
    editor.destroy();
    release = null;
  });

  function suggestions() {
    manager.shouldDisplaySuggestions = true;
    return manager.getSuggestionsFromProviders({
      editor,
      bufferPosition: editor.getCursorBufferPosition(),
      scopeDescriptor: editor.getRootScopeDescriptor(),
      prefix: "c",
      legacyPrefix: "c",
    });
  }

  it("never invokes a provider or reads a prefix for None, and resumes with a grammar", async () => {
    const grammar = editor.getGrammar();
    editor.setGrammar(lumine.grammars.nullGrammar);
    const prefix = spyOn(manager, "getPrefix").and.callThrough();
    await manager.findSuggestions(true);
    await suggestions();
    expect(prefix).not.toHaveBeenCalled();
    expect(release).toBeUndefined();
    editor.setGrammar(grammar);
    const pending = suggestions();
    expect(typeof release).toBe("function");
    release([]);
    await pending;
  });

  for (const change of ["grammar", "query epoch"]) {
    it(`does not publish a late provider result after ${change} changes`, async () => {
      spyOn(manager, "displaySuggestions").and.callThrough();
      const pending = suggestions();
      if (change === "grammar") {
        editor.setGrammar(lumine.grammars.nullGrammar);
        expect(editor.getBuffer().getLanguageMode()).not.toBe(mode);
      } else epoch++;
      release([{ text: "console" }]);
      await pending;
      expect(manager.displaySuggestions).not.toHaveBeenCalled();
      expect(manager.suggestionList.isActive()).toBe(false);
    });
  }

  it("keeps a pending provider result through a paint-only refresh", async () => {
    spyOn(manager, "displaySuggestions");
    const pending = suggestions();
    await mode.refresh?.();
    release([{ text: "console" }]);
    await pending;
    expect(manager.displaySuggestions).toHaveBeenCalled();
  });

  for (const change of ["readOnly", "query epoch"]) {
    it(`keeps a typed commit character after ${change} changes while resolving details`, async () => {
      editor.setText("c(");
      editor.setCursorBufferPosition([0, 2]);
      manager.cancelSuggestions();
      const suggestion = { text: "console", replacementPrefix: "c" };
      manager.pendingDetails.set(suggestion, new Promise((resolve) => (release = resolve)));
      const pending = manager.confirmWithCommitCharacter(suggestion, "(", [
        [0, 1],
        [0, 2],
      ]);
      if (change === "readOnly") editor.setReadOnly(true);
      else epoch++;
      release(suggestion);
      await expectAsync(pending).toBeResolved();
      expect(editor.getText()).toBe("c(");
      expect(editor.getCursorBufferPosition().toArray()).toEqual([0, 2]);
    });
  }

  it("discards a confirmation whose details belong to a previous query epoch", async () => {
    const suggestion = { text: "console", replacementPrefix: "c" };
    manager.pendingDetails.set(suggestion, new Promise((resolve) => (release = resolve)));
    const pending = manager.confirm(suggestion);
    epoch++;
    release(suggestion);
    await pending;
    expect(editor.getText()).toBe("c");
  });

  it("does not accept an existing popup after its scope configuration changes", async () => {
    const pending = suggestions();
    release([{ text: "console" }]);
    await pending;
    const suggestion = manager.suggestionList.items[0];
    epoch++;
    await manager.confirm(suggestion);
    expect(editor.getText()).toBe("c");
  });

  it("discards a prepared snippet whose syntax configuration changed", async () => {
    const original = manager.snippetsManager;
    manager.snippetsManager = {
      prepareSnippet: () => new Promise((resolve) => (release = resolve)),
    };
    try {
      const pending = manager.confirm({ snippet: "console(${1:value})", replacementPrefix: "c" });
      epoch++;
      release({ isCurrent: () => true });
      await pending;
      expect(editor.getText()).toBe("c");
    } finally {
      manager.snippetsManager = original;
    }
  });

  it("owns a rejected commit-character task dispatched by a buffer event", async () => {
    const error = new Error("Snippet preparation failed");
    const rejected = Promise.reject(error);
    // Keep the baseline run observable without letting its unowned rejection
    // abort the suite before the missing event-boundary handler is asserted.
    void rejected.catch(() => {});
    spyOn(console, "error");
    spyOn(manager, "suggestionForCommitCharacter").and.returnValue({ text: "console" });
    spyOn(manager, "confirmWithCommitCharacter").and.returnValue(rejected);
    editor.insertText("(");
    await Promise.resolve();
    expect(console.error).toHaveBeenCalledWith("Unable to confirm completion", error);
    expect(editor.getText()).toBe("c(");
  });

  it("does not prepare a snippet after its pending commit was cancelled", async () => {
    editor.setText("c(");
    editor.setCursorBufferPosition([0, 2]);
    manager.cancelSuggestions();
    const suggestion = { snippet: "console(${1:value})", replacementPrefix: "c" };
    const original = manager.snippetsManager;
    manager.snippetsManager = { prepareSnippet: jasmine.createSpy("cancelled preparation") };
    try {
      manager.pendingDetails.set(suggestion, new Promise((resolve) => (release = resolve)));
      const pending = manager.confirmWithCommitCharacter(suggestion, "(", [
        [0, 1],
        [0, 2],
      ]);
      manager.cancelSuggestions();
      release(suggestion);
      await pending;
      expect(manager.snippetsManager.prepareSnippet).not.toHaveBeenCalled();
      expect(editor.getText()).toBe("c(");
    } finally {
      manager.snippetsManager = original;
    }
  });
});
