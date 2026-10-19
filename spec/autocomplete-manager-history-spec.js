require("./spec-helper");

describe("Autocomplete Manager history changes", () => {
  let editor, editorView, manager, registration, requests;

  const latestCompletion = () => manager.findSuggestions.calls.mostRecent().returnValue;
  const resolveRequest = async (index) => {
    requests[index].resolve([{ text: "about", commitCharacters: ["("] }]);
    await requests[index].completion;
  };
  const type = (text) => {
    editor.insertText(text);
    requests[requests.length - 1].completion = latestCompletion();
  };
  const activate = () => {
    lumine.commands.dispatch(editorView, "autocomplete:activate");
    requests[requests.length - 1].completion = latestCompletion();
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
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    editor = await lumine.workspace.open("");
    editorView = lumine.views.getView(editor);
    const pack = await lumine.packages.activatePackage("autocomplete");
    manager = pack.mainModule.autocompleteManager;
    editorView.focus();
    requests = [];
    registration = pack.mainModule.consumeAutocomplete({
      scopeSelector: "*",
      inclusionPriority: 2,
      excludeLowerPriority: true,
      triggerCharacters: new Set(["."]),
      getSuggestions(options) {
        return new Promise((resolve) => requests.push({ options, resolve }));
      },
    });
    spyOn(manager, "findSuggestions").and.callThrough();
  });

  afterEach(() => {
    manager.cancelSuggestions();
    registration.dispose();
  });

  it("closes the visible list on undo and stays closed on redo, then completes new typing", async () => {
    type("a");
    await resolveRequest(0);
    type("b");
    await resolveRequest(1);
    expect(manager.suggestionList.isActive()).toBe(true);

    lumine.commands.dispatch(editorView, "core:undo");
    expect(editor.getText()).toBe("a");
    expectClosed();
    lumine.commands.dispatch(editorView, "core:redo");
    expect(editor.getText()).toBe("ab");
    expectClosed();
    expect(requests.length).toBe(2);

    type("c");
    await resolveRequest(2);
    expect(manager.suggestionList.isActive()).toBe(true);
    expect(editor.getText()).toBe("abc");
  });

  for (const character of ["a", "."]) {
    it(`does not activate when undoing a deletion restores ${JSON.stringify(character)}`, () => {
      lumine.config.set("autocomplete.enableAutoActivation", false);
      editor.insertText(character);
      editor.getBuffer().clearUndoStack();
      editor.backspace();
      manager.cancelSuggestions();
      const previousRequests = requests.length;
      lumine.config.set("autocomplete.enableAutoActivation", character !== ".");

      lumine.commands.dispatch(editorView, "core:undo");

      expect(editor.getText()).toBe(character);
      expect(requests.length).toBe(previousRequests);
      expect(manager.triggerCharacter).toBeNull();
      expectClosed();
    });
  }

  for (const command of ["core:undo", "core:redo"]) {
    it(`discards the pending provider response on ${command} and permits manual activation`, async () => {
      type("a");
      let pendingIndex = 0;
      if (command === "core:redo") {
        lumine.commands.dispatch(editorView, "core:undo");
        activate();
        pendingIndex = 1;
      }

      lumine.commands.dispatch(editorView, command);

      expect(manager.currentSuggestionsPromise).toBeNull();
      expect(requests.length).toBe(pendingIndex + 1);
      await resolveRequest(pendingIndex);
      expectClosed();
      expect(editor.getText()).toBe(command === "core:undo" ? "" : "a");

      activate();
      await resolveRequest(pendingIndex + 1);
      expect(manager.suggestionList.isActive()).toBe(true);
      expect(requests[pendingIndex + 1].options.activatedManually).toBe(true);
    });
  }

  it("cancels delayed activation on undo and schedules it again for later typing", async () => {
    lumine.config.set("autocomplete.autoActivationDelay", 1000);
    editor.insertText("a");
    const timer = manager.delayTimeout;
    expect(timer).not.toBeNull();

    lumine.commands.dispatch(editorView, "core:undo");

    expect(window.clearTimeout).toHaveBeenCalledWith(timer);
    expect(manager.delayTimeout).toBeNull();
    advanceClock(1000);
    expect(manager.findSuggestions).not.toHaveBeenCalled();
    expectClosed();

    editor.insertText("b");
    advanceClock(1000);
    expect(requests.length).toBe(1);
    requests[0].completion = latestCompletion();
    await resolveRequest(0);
    expect(manager.suggestionList.isActive()).toBe(true);
  });

  it("does not accept a suggestion when redo restores its commit character", async () => {
    lumine.config.set("autocomplete.enableAutoActivation", false);
    lumine.config.set("autocomplete.commitCharacters", true);
    editor.insertText("a");
    editor.insertText("(");
    lumine.commands.dispatch(editorView, "core:undo");
    activate();
    await resolveRequest(0);
    expect(manager.suggestionList.isActive()).toBe(true);
    spyOn(manager, "confirmWithCommitCharacter").and.callThrough();

    lumine.commands.dispatch(editorView, "core:redo");

    expect(editor.getText()).toBe("a(");
    expect(manager.confirmWithCommitCharacter).not.toHaveBeenCalled();
    expect(requests.length).toBe(1);
    expectClosed();
  });
});
