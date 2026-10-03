require("./spec-helper");

describe("Autocomplete Manager deleting a prefix", () => {
  let editor, editorView, manager, provider, registration, requests;

  const latestCompletion = () => manager.findSuggestions.calls.mostRecent().returnValue;
  const type = (text) => {
    editor.insertText(text);
    return latestCompletion();
  };
  const expectClosed = () => {
    expect(manager.suggestionList.isActive()).toBe(false);
    expect(editorView.classList.contains("autocomplete-active")).toBe(false);
    expect(editorView.querySelector(".autocomplete")).not.toExist();
  };

  beforeEach(async () => {
    lumine.config.set("autocomplete.enableAutoActivation", true);
    lumine.config.set("autocomplete.autoActivationDelay", 0);
    lumine.config.set("autocomplete.enableAutoConfirmSingleSuggestion", false);
    lumine.config.set("autocomplete.backspaceTriggersAutocomplete", false);
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    editor = await lumine.workspace.open("");
    editorView = lumine.views.getView(editor);
    const pack = await lumine.packages.activatePackage("autocomplete");
    manager = pack.mainModule.autocompleteManager;
    editorView.focus();
    requests = [];
    provider = {
      scopeSelector: "*",
      inclusionPriority: 2,
      excludeLowerPriority: true,
      getSuggestions(options) {
        requests.push(options);
        // External providers may return suggestions even for an empty prefix.
        return [{ text: "keyword" }];
      },
    };
    registration = pack.mainModule.consumeAutocomplete(provider);
    spyOn(manager, "findSuggestions").and.callThrough();
  });

  afterEach(() => {
    manager.cancelSuggestions();
    registration.dispose();
  });

  for (const backspaceTriggersAutocomplete of [false, true]) {
    it(`closes after the last character is deleted with backspace activation ${backspaceTriggersAutocomplete ? "enabled" : "disabled"}`, async () => {
      lumine.config.set(
        "autocomplete.backspaceTriggersAutocomplete",
        backspaceTriggersAutocomplete,
      );
      await type("k");
      expect(manager.suggestionList.isActive()).toBe(true);

      editor.backspace();

      expect(editor.getText()).toBe("");
      expectClosed();
      expect(requests.length).toBe(1);
    });
  }

  it("closes as soon as deletion takes the prefix below the configured minimum", async () => {
    lumine.config.set("autocomplete.minimumWordLength", 3);
    editor.insertText("ke");
    await type("y");
    expect(manager.suggestionList.isActive()).toBe(true);

    editor.backspace();

    expect(editor.getText()).toBe("ke");
    expectClosed();
    expect(requests.length).toBe(1);
  });

  it("updates suggestions when the remaining prefix still meets the minimum", async () => {
    editor.insertText("k");
    await type("e");
    editor.backspace();
    await latestCompletion();

    expect(requests[requests.length - 1].prefix).toBe("k");
    expect(manager.suggestionList.isActive()).toBe(true);
  });

  it("closes when the whole selected prefix is deleted", async () => {
    editor.insertText("ke");
    await type("y");
    editor.selectAll();
    editor.delete();

    expect(editor.getText()).toBe("");
    expectClosed();
  });

  it("discards an in-flight response when the last character is deleted", async () => {
    lumine.config.set("autocomplete.backspaceTriggersAutocomplete", true);
    let resolveSuggestions;
    provider.getSuggestions = () =>
      new Promise((resolve) => {
        resolveSuggestions = resolve;
      });
    const completion = type("k");

    editor.backspace();
    resolveSuggestions([{ text: "keyword" }]);
    await completion;

    expectClosed();
    expect(manager.currentSuggestionsPromise).toBeNull();
  });

  it("cancels a delayed refresh when the last character is deleted", async () => {
    await type("k");
    lumine.config.set("autocomplete.autoActivationDelay", 1000);
    editor.insertText("e");
    const timer = manager.delayTimeout;
    editor.backspace();
    editor.backspace();
    advanceClock(1000);

    expect(window.clearTimeout).toHaveBeenCalledWith(timer);
    expect(manager.delayTimeout).toBeNull();
    expect(requests.length).toBe(1);
    expectClosed();
  });

  it("allows manual activation with an empty prefix after deletion", async () => {
    await type("k");
    editor.backspace();
    expectClosed();

    lumine.commands.dispatch(editorView, "autocomplete:activate");
    await latestCompletion();

    expect(requests[requests.length - 1].prefix).toBe("");
    expect(requests[requests.length - 1].activatedManually).toBe(true);
    expect(manager.suggestionList.isActive()).toBe(true);
  });

  it("still opens an empty-prefix list on a declared trigger character", async () => {
    provider.triggerCharacters = new Set(["."]);
    lumine.config.set("autocomplete.enableAutoActivation", false);
    await type(".");

    expect(requests[0].prefix).toBe("");
    expect(requests[0].triggerCharacter).toBe(".");
    expect(manager.suggestionList.isActive()).toBe(true);

    editor.backspace();
    expectClosed();
  });

  it("allows empty-prefix suggestions after deletion when the minimum is zero", async () => {
    lumine.config.set("autocomplete.minimumWordLength", 0);
    await type("k");
    editor.backspace();
    await latestCompletion();

    expect(requests[requests.length - 1].prefix).toBe("");
    expect(manager.suggestionList.isActive()).toBe(true);
  });
});
