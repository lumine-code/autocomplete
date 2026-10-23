const { conditionPromise } = require("./spec-helper");

describe("Autocomplete event request failures", () => {
  let editor, manager, registration, failure, pending, release;
  beforeEach(async () => {
    jasmine.useRealClock();
    lumine.config.set("autocomplete.enableAutoActivation", false);
    lumine.config.set("autocomplete.autoActivationDelay", 0);
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    await lumine.packages.activatePackage("language-javascript");
    editor = await lumine.workspace.open();
    editor.setText("c");
    lumine.grammars.assignLanguageMode(editor.getBuffer(), "source.js");
    await editor.whenGrammarSettled();
    const pack = await lumine.packages.activatePackage("autocomplete");
    manager = pack.mainModule.autocompleteManager;
    await manager.prepareCompletion();
    lumine.views.getView(editor).focus();
    editor.setCursorBufferPosition([0, 1]);
    manager.cancelSuggestions();
    failure = new Error("Expected completion provider failure");
    registration = pack.mainModule.consumeAutocomplete({
      scopeSelector: "*",
      inclusionPriority: 10,
      excludeLowerPriority: true,
      getSuggestions: () => Promise.reject(failure),
    });
    spyOn(console, "error");
    const find = manager.findSuggestions.bind(manager);
    spyOn(manager, "findSuggestions").and.callFake((...args) => {
      pending = find(...args);
      // Observe the real rejected request without letting the baseline's
      // unowned rejection interrupt the missing-boundary assertion.
      void pending?.catch(() => {});
      return pending;
    });
  });
  afterEach(() => {
    release?.();
    manager.cancelSuggestions();
    registration.dispose();
    editor.destroy();
    pending = release = null;
  });

  for (const source of ["provider", "scope query"]) {
    for (const trigger of ["manual", "automatic", "delayed automatic", "indent retry"]) {
      it(`owns a ${source} rejection from ${trigger}`, async () => {
        if (source === "scope query")
          spyOn(editor, "getScopeDescriptorsForBufferPositions").and.callFake(() =>
            Promise.reject(failure),
          );
        if (trigger === "manual") {
          lumine.commands.dispatch(lumine.views.getView(editor), "autocomplete:activate");
        } else if (trigger === "indent retry") {
          manager.shouldDisplaySuggestions = true;
          manager.cancelHideSuggestionListRequest();
          spyOn(editor, "isApplyingAutomaticIndentation").and.returnValue(true);
          editor.getBuffer().insert([0, 0], " ");
        } else {
          lumine.config.set("autocomplete.enableAutoActivation", true);
          lumine.config.set("autocomplete.autoActivationDelay", trigger === "automatic" ? 0 : 10);
          editor.insertText("o");
        }
        await conditionPromise(() => Boolean(pending));
        await pending.catch(() => {});
        await Promise.resolve();
        expect(console.error).toHaveBeenCalledWith("Unable to request completions", failure);
        expect(manager.shouldDisplaySuggestions).toBe(false);
        expect(manager.suggestionList.isActive()).toBe(false);
      });
    }
  }

  it("preserves rejection for callers that explicitly await findSuggestions", async () => {
    await expectAsync(manager.findSuggestions()).toBeRejectedWith(failure);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("does not cancel or report over a newer request when an old event request fails", async () => {
    spyOn(editor, "getScopeDescriptorsForBufferPositions").and.callFake(
      () =>
        new Promise((_resolve, reject) => {
          release = () => reject(failure);
        }),
    );
    lumine.commands.dispatch(lumine.views.getView(editor), "autocomplete:activate");
    const old = pending;
    manager.cancelSuggestions();
    manager.shouldDisplaySuggestions = true;
    release();
    await old.catch(() => {});
    await Promise.resolve();
    expect(console.error).not.toHaveBeenCalled();
    expect(manager.shouldDisplaySuggestions).toBe(true);
  });
});
