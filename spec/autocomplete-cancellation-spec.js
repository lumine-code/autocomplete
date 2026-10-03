require("./spec-helper");

describe("Autocomplete cancellation", () => {
  let editor, editorView, manager, provider, registration, requests, otherEditor;

  const latestCompletion = () => manager.findSuggestions.calls.mostRecent().returnValue;
  const resolveRequest = async (index, text = "about") => {
    requests[index].resolve([{ text }]);
    await requests[index].completion;
  };
  const type = (text) => {
    editor.insertText(text);
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
    expect(manager.editor).toBe(editor);
    requests = [];
    provider = {
      scopeSelector: "*",
      inclusionPriority: 2,
      excludeLowerPriority: true,
      getSuggestions(options) {
        return new Promise((resolve) => requests.push({ options, resolve }));
      },
    };
    registration = pack.mainModule.consumeAutocomplete(provider);
    spyOn(manager, "findSuggestions").and.callThrough();
  });

  afterEach(() => {
    manager.cancelSuggestions();
    registration.dispose();
    otherEditor?.destroy();
    otherEditor = null;
  });

  it("cancels a pending provider before the popup has been created", async () => {
    type("a");
    expect(requests.length).toBe(1);
    expect(manager.suggestionList._suggestionListElement).toBeUndefined();
    expect(lumine.commands.dispatch(editorView, "autocomplete:cancel")).not.toBeNull();
    expect(manager.currentSuggestionsPromise).toBeNull();

    await resolveRequest(0);

    expectClosed();
    expect(manager.suggestionList._suggestionListElement).toBeUndefined();
  });

  it("discards the cancelled response even after new typing opens a fresh list", async () => {
    type("a");
    lumine.commands.dispatch(editorView, "autocomplete:cancel");
    type("b");
    expect(requests.length).toBe(2);

    await resolveRequest(1, "about");
    expect(manager.suggestionList.isActive()).toBe(true);
    await resolveRequest(0, "ancient");

    expect(manager.suggestionList.items.map((item) => item.text)).toEqual(["about"]);
    expect(manager.suggestionList.activeEditor).toBe(editor);
  });

  it("cancels the activation timer and schedules a new one for later typing", async () => {
    lumine.config.set("autocomplete.autoActivationDelay", 1000);
    editor.insertText("a");
    const timer = manager.delayTimeout;
    expect(timer).not.toBeNull();

    lumine.commands.dispatch(editorView, "autocomplete:cancel");
    expect(window.clearTimeout).toHaveBeenCalledWith(timer);
    expect(manager.delayTimeout).toBeNull();
    advanceClock(1000);

    expect(manager.findSuggestions).not.toHaveBeenCalled();
    expect(requests.length).toBe(0);
    expectClosed();

    editor.insertText("b");
    advanceClock(1000);
    expect(requests.length).toBe(1);
    requests[0].completion = latestCompletion();
    await resolveRequest(0);
    expect(manager.suggestionList.activeEditor).toBe(editor);
  });

  it("hides an already visible list and emits cancellation only once", async () => {
    type("a");
    await resolveRequest(0);
    expect(manager.suggestionList.isActive()).toBe(true);
    spyOn(manager.suggestionList, "cancel").and.callThrough();

    lumine.commands.dispatch(editorView, "autocomplete:cancel");

    expect(manager.suggestionList.cancel.calls.count()).toBe(1);
    expectClosed();
    expect(manager.suggestionList.items).toBeNull();
  });

  it("allows manual activation after cancellation", async () => {
    type("a");
    lumine.commands.dispatch(editorView, "autocomplete:cancel");
    await resolveRequest(0);

    lumine.commands.dispatch(editorView, "autocomplete:activate");
    requests[1].completion = latestCompletion();
    await resolveRequest(1);

    expect(manager.suggestionList.activeEditor).toBe(editor);
    expect(manager.suggestionList.items.map((item) => item.text)).toEqual(["about"]);
  });

  it("keeps another editor's pending request and popup when the old editor is cancelled", async () => {
    const oldEditorView = editorView;
    otherEditor = await lumine.workspace.open("");
    lumine.views.getView(otherEditor).focus();
    otherEditor.insertText("b");
    requests[0].completion = latestCompletion();
    const pending = manager.currentSuggestionsPromise;

    lumine.commands.dispatch(oldEditorView, "autocomplete:cancel");
    expect(manager.currentSuggestionsPromise).toBe(pending);
    await resolveRequest(0, "better");
    expect(manager.suggestionList.activeEditor).toBe(otherEditor);

    lumine.commands.dispatch(oldEditorView, "autocomplete:cancel");
    expect(manager.suggestionList.activeEditor).toBe(otherEditor);
    expect(manager.suggestionList.items.map((item) => item.text)).toEqual(["better"]);
  });

  it("discards a response when focus moves to another watched editor", async () => {
    type("a");
    otherEditor = await lumine.workspace.open("");
    lumine.views.getView(otherEditor).focus();
    expect(manager.editor).toBe(otherEditor);

    await resolveRequest(0);

    expectClosed();
    expect(lumine.views.getView(otherEditor).querySelector(".autocomplete")).not.toExist();
  });

  it("clears pending activation when the package is deactivated", async () => {
    lumine.config.set("autocomplete.autoActivationDelay", 1000);
    editor.insertText("a");
    const timer = manager.delayTimeout;

    await lumine.packages.deactivatePackage("autocomplete");
    expect(window.clearTimeout).toHaveBeenCalledWith(timer);
    advanceClock(1000);

    expect(manager.findSuggestions).not.toHaveBeenCalled();
    expect(requests.length).toBe(0);
  });

  describe("while confirmation waits for suggestion details", () => {
    let resolveDetails, suggestion, confirmed;

    beforeEach(async () => {
      provider.getSuggestionDetailsOnSelect = () =>
        new Promise((resolve) => {
          resolveDetails = resolve;
        });
      type("a");
      await resolveRequest(0);
      await new Promise((resolve) => process.nextTick(resolve));
      suggestion = manager.suggestionList.items[0];
      expect(manager.pendingDetails.has(suggestion)).toBe(true);
      confirmed = manager.confirm(suggestion);
    });

    const finishDetails = () => {
      resolveDetails({
        ...suggestion,
        additionalTextEdits: [
          {
            range: [
              [0, 0],
              [0, 0],
            ],
            newText: "imported\n",
          },
        ],
      });
      return confirmed;
    };

    it("does not insert completion text or additional edits after cancellation", async () => {
      lumine.commands.dispatch(editorView, "autocomplete:cancel");
      await finishDetails();

      expect(editor.getText()).toBe("a");
      expectClosed();
    });

    for (const returnFocus of [false, true]) {
      it(`does not insert in either editor after focus switches ${returnFocus ? "away and back" : "away"}`, async () => {
        lumine.config.set("autocomplete.enableAutoActivation", false);
        otherEditor = await lumine.workspace.open("");
        const otherView = lumine.views.getView(otherEditor);
        otherView.focus();
        otherEditor.insertText("a");
        if (returnFocus) editorView.focus();
        await finishDetails();

        expect(editor.getText()).toBe("a");
        expect(otherEditor.getText()).toBe("a");
        expectClosed();
      });
    }

    it("does not insert after typing starts a newer suggestion request", async () => {
      type("b");
      expect(requests.length).toBe(2);
      await finishDetails();
      expect(editor.getText()).toBe("ab");

      await resolveRequest(1, "absolute");
      expect(manager.suggestionList.items.map((item) => item.text)).toEqual(["absolute"]);
    });

    it("does not apply old edits after the buffer changes away from the cursor", async () => {
      editor.getBuffer().append("\nother edit");
      await finishDetails();

      expect(editor.getText()).toBe("a\nother edit");
    });

    it("does not insert after the cursor moves during confirmation", async () => {
      editor.setCursorBufferPosition([0, 0]);
      await finishDetails();

      expect(editor.getText()).toBe("a");
    });

    it("still inserts the completion and additional edits when the context stays current", async () => {
      await finishDetails();

      expect(editor.getText()).toBe("imported\nabout");
      expectClosed();
    });
  });

  describe("when a commit character confirms with pending details", () => {
    let resolveDetails, suggestion, confirmation;

    beforeEach(async () => {
      lumine.config.set("autocomplete.commitCharacters", true);
      provider.getSuggestionDetailsOnSelect = () =>
        new Promise((resolve) => {
          resolveDetails = resolve;
        });
      type("a");
      requests[0].resolve([{ text: "about", commitCharacters: ["("] }]);
      await requests[0].completion;
      await new Promise((resolve) => process.nextTick(resolve));
      suggestion = manager.suggestionList.items[0];
      spyOn(manager, "confirmWithCommitCharacter").and.callThrough();
      editor.insertText("(");
      confirmation = manager.confirmWithCommitCharacter.calls.mostRecent().returnValue;
    });

    const finishDetails = () => {
      resolveDetails({
        ...suggestion,
        additionalTextEdits: [
          {
            range: [
              [0, 0],
              [0, 0],
            ],
            newText: "imported\n",
          },
        ],
      });
      return confirmation;
    };

    it("preserves normal confirmation and its single undo step", async () => {
      await finishDetails();

      expect(editor.getText()).toBe("imported\nabout(");
      editor.undo();
      expect(editor.getText()).toBe("a(");
    });

    it("keeps the typed character without inserting a cancelled completion", async () => {
      lumine.config.set("autocomplete.enableAutoActivation", false);
      lumine.commands.dispatch(editorView, "autocomplete:cancel");
      // Run captures source immediately after dispatching cancellation.
      expect(editor.getText()).toBe("a(");
      await finishDetails();

      expect(editor.getText()).toBe("a(");
      expectClosed();
    });

    it("does not apply old completion edits after more typing while details are pending", async () => {
      editor.insertText("b");
      expect(editor.getText()).toBe("a(b");
      await finishDetails();

      expect(editor.getText()).toBe("a(b");
    });

    it("does not confirm the old suggestion again when its commit character is repeated", async () => {
      editor.insertText("(");
      expect(manager.confirmWithCommitCharacter.calls.count()).toBe(1);
      expect(requests.length).toBe(2);
      expect(editor.getText()).toBe("a((");
      await finishDetails();

      expect(editor.getText()).toBe("a((");
    });

    it("keeps the typed character in its original editor after focus changes", async () => {
      otherEditor = await lumine.workspace.open("");
      lumine.views.getView(otherEditor).focus();
      expect(editor.getText()).toBe("a(");
      await finishDetails();

      expect(editor.getText()).toBe("a(");
      expect(otherEditor.getText()).toBe("");
    });

    it("keeps literal source if the cursor moves while details are pending", async () => {
      editor.setCursorBufferPosition([0, 0]);
      await finishDetails();

      expect(editor.getText()).toBe("a(");
      expect(editor.getCursorBufferPosition()).toEqual([0, 0]);
    });

    it("does not recreate text deleted while details are pending", async () => {
      editor.setTextInBufferRange(
        [
          [0, 0],
          [0, 2],
        ],
        "",
      );
      await finishDetails();

      expect(editor.getText()).toBe("");
    });
  });
});
