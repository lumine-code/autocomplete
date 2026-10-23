const { conditionPromise } = require("./spec-helper");

describe("Incremental completion provider publication", () => {
  let editor, main, manager, registrations, gates, requests;
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const gate = { promise, resolve, reject };
    gates.push(gate);
    return gate;
  };
  const provider = (getSuggestions, options = {}) => {
    const value = {
      scopeSelector: "*",
      inclusionPriority: 10,
      excludeLowerPriority: true,
      suggestionPriority: 1,
      getSuggestions: jasmine.createSpy("getSuggestions").and.callFake(getSuggestions),
      ...options,
    };
    registrations.push(main.consumeAutocomplete(value));
    return value;
  };
  const request = (activatedManually = false) => {
    manager.shouldDisplaySuggestions = true;
    const promise = manager.getSuggestionsFromProviders({
      editor,
      bufferPosition: editor.getCursorBufferPosition(),
      scopeDescriptor: editor.getRootScopeDescriptor(),
      prefix: "a",
      legacyPrefix: "a",
      activatedManually,
    });
    requests.push(promise);
    void promise.catch(() => {});
    return promise;
  };
  const visible = (text) =>
    conditionPromise(
      () =>
        manager.suggestionList.isActive() &&
        manager.suggestionList.items?.some((item) => item.text === text),
    );

  beforeEach(async () => {
    jasmine.useRealClock();
    registrations = [];
    gates = [];
    requests = [];
    lumine.config.set("autocomplete.enableAutoActivation", false);
    lumine.config.set("autocomplete.enableAutoConfirmSingleSuggestion", false);
    lumine.config.set("autocomplete.similarSuggestionRemoval", "none");
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    editor = await lumine.workspace.open();
    editor.setText("a");
    editor.setCursorBufferPosition([0, 1]);
    main = (await lumine.packages.activatePackage("autocomplete")).mainModule;
    manager = main.autocompleteManager;
    await manager.prepareCompletion();
    lumine.views.getView(editor).focus();
    manager.cancelSuggestions();
  });
  afterEach(async () => {
    manager.cancelSuggestions();
    for (const gate of gates) gate.resolve([]);
    await Promise.allSettled(requests);
    for (const registration of registrations) registration.dispose();
    editor.destroy();
  });

  it("shows ready words without waiting for a higher-priority provider and then keeps provider order", async () => {
    const slow = deferred();
    provider(() => slow.promise, { suggestionPriority: 20 });
    provider(() => [{ text: "alpha" }]);
    let finished = false;
    const pending = request().then(() => {
      finished = true;
    });
    await visible("alpha");
    expect(finished).toBe(false);
    expect(manager.suggestionList.items.map((item) => item.text)).toEqual(["alpha"]);
    slow.resolve([{ text: "atlas" }]);
    await pending;
    expect(manager.suggestionList.items.map((item) => item.text)).toEqual(["atlas", "alpha"]);
    expect(manager.suggestionAbortController).toBeNull();
  });

  it("never publishes a ready provider excluded by a pending provider's inclusion priority", async () => {
    const slow = deferred();
    provider(() => slow.promise, { inclusionPriority: 20 });
    const excluded = provider(() => [{ text: "alpha" }]);
    const pending = request();
    await Promise.resolve();
    await Promise.resolve();
    expect(excluded.getSuggestions).not.toHaveBeenCalled();
    expect(manager.suggestionList.isActive()).toBe(false);
    slow.resolve([{ text: "atlas" }]);
    await pending;
    expect(manager.suggestionList.items.map((item) => item.text)).toEqual(["atlas"]);
  });

  it("coalesces synchronous providers into one final publication", async () => {
    provider(() => [{ text: "alpha" }]);
    provider(() => [{ text: "atlas" }]);
    spyOn(manager, "displaySuggestions").and.callThrough();
    await request();
    expect(manager.displaySuggestions).toHaveBeenCalledTimes(1);
  });

  it("does not rebuild an unchanged partial list when the last provider has no suggestions", async () => {
    const slow = deferred();
    provider(() => slow.promise);
    provider(() => [{ text: "alpha" }]);
    spyOn(manager, "displaySuggestions").and.callThrough();
    const pending = request();
    await visible("alpha");
    slow.resolve([]);
    await pending;
    expect(manager.displaySuggestions).toHaveBeenCalledTimes(1);
  });

  it("waits for all providers before manually auto-confirming a single result", async () => {
    lumine.config.set("autocomplete.enableAutoConfirmSingleSuggestion", true);
    const slow = deferred();
    provider(() => slow.promise);
    provider(() => [{ text: "alpha" }]);
    spyOn(manager, "confirm").and.callThrough();
    const pending = request(true);
    await visible("alpha");
    expect(editor.getText()).toBe("a");
    expect(manager.confirm).not.toHaveBeenCalled();
    slow.resolve([]);
    await pending;
    expect(editor.getText()).toBe("alpha");
    expect(manager.confirm).toHaveBeenCalledTimes(1);
  });

  it("does not auto-confirm after the user explicitly chose the partial result", async () => {
    lumine.config.set("autocomplete.enableAutoConfirmSingleSuggestion", true);
    const slow = deferred();
    provider(() => slow.promise);
    provider(() => [{ text: "alpha" }]);
    const pending = request(true);
    await visible("alpha");
    manager.suggestionList.suggestionListElement.setSelectedIndex(0);
    slow.resolve([]);
    await pending;
    expect(editor.getText()).toBe("a");
    expect(manager.suggestionList.isActive()).toBe(true);
  });

  it("does not inherit a previous request's selected row when manually auto-confirming a new single result", async () => {
    lumine.config.set("autocomplete.enableAutoConfirmSingleSuggestion", true);
    const source = provider(() => [{ text: "alpha" }, { text: "alpine" }]);
    await request();
    manager.suggestionList.suggestionListElement.setSelectedIndex(1);
    source.getSuggestions.and.returnValue([{ text: "atlas" }]);
    await request(true);
    expect(editor.getText()).toBe("atlas");
  });

  it("reuses details already resolved for a partial single suggestion when all providers finish", async () => {
    lumine.config.set("autocomplete.enableAutoConfirmSingleSuggestion", true);
    const slow = deferred();
    provider(() => slow.promise);
    const fast = provider(() => [{ text: "alpha" }], {
      getSuggestionDetailsOnSelect: jasmine
        .createSpy("detail")
        .and.callFake((suggestion) => Promise.resolve({ ...suggestion, description: "Resolved" })),
    });
    const pending = request(true);
    await visible("alpha");
    await conditionPromise(() => manager.suggestionList.items[0].description === "Resolved");
    slow.resolve([]);
    await pending;
    expect(editor.getText()).toBe("alpha");
    expect(fast.getSuggestionDetailsOnSelect).toHaveBeenCalledTimes(1);
  });

  it("keeps an explicit user choice when higher-priority preselected entries arrive", async () => {
    const slow = deferred();
    provider(() => slow.promise, { suggestionPriority: 20 });
    provider(() => [{ text: "alpha" }, { text: "alpine" }]);
    const pending = request();
    await visible("alpine");
    const view = manager.suggestionList.suggestionListElement;
    view.setSelectedIndex(1);
    const chosen = view.getSelectedItem();
    slow.resolve([{ text: "atlas", preselect: true }]);
    await pending;
    expect(manager.suggestionList.items.map((item) => item.text)).toEqual([
      "atlas",
      "alpha",
      "alpine",
    ]);
    expect(view.getSelectedItem()).toBe(chosen);
    expect(view.nonDefaultIndex).toBe(true);
  });

  it("does not substitute another provider's same-text suggestion for the user's chosen edit", async () => {
    lumine.config.set("autocomplete.similarSuggestionRemoval", "textOrSnippet");
    const slow = deferred();
    provider(() => slow.promise, { suggestionPriority: 20 });
    const local = provider(() => [{ text: "alpha" }]);
    const pending = request();
    await visible("alpha");
    const view = manager.suggestionList.suggestionListElement;
    view.setSelectedIndex(0);
    const chosen = view.getSelectedItem();
    slow.resolve([{ text: "alpha" }]);
    await pending;
    expect(manager.suggestionList.items.length).toBe(2);
    expect(view.getSelectedItem()).toBe(chosen);
    expect(view.getSelectedItem().provider).toBe(local);
  });

  it("retains the chosen item at the visible cap without changing canonical provider order", async () => {
    lumine.config.set("autocomplete.maxSuggestions", 2);
    const slow = deferred();
    provider(() => slow.promise, { suggestionPriority: 20 });
    provider(() => [{ text: "alpha" }, { text: "alpine" }]);
    const pending = request();
    await visible("alpine");
    const view = manager.suggestionList.suggestionListElement;
    view.setSelectedIndex(1);
    const chosen = view.getSelectedItem();
    slow.resolve([{ text: "aardvark" }, { text: "atlas" }]);
    await pending;
    expect(manager.suggestionList.items.map((item) => item.text)).toEqual([
      "aardvark",
      "atlas",
      "alpha",
      "alpine",
    ]);
    expect(view.visibleItems().length).toBe(2);
    expect(view.getSelectedItem()).toBe(chosen);
    view.setSelectedIndex(0);
    expect(view.getSelectedItem().text).toBe("aardvark");
    expect(view.visibleItems().map((item) => item.text)).toEqual(["aardvark", "atlas"]);
  });

  it("retains resolved detail edits through a later provider publication without resolving again", async () => {
    const slow = deferred(),
      detail = deferred();
    provider(() => slow.promise, { suggestionPriority: 20 });
    const fast = provider(() => [{ text: "alpha" }], {
      getSuggestionDetailsOnSelect: jasmine.createSpy("detail").and.returnValue(detail.promise),
    });
    const pending = request();
    await visible("alpha");
    const initial = manager.suggestionList.items[0];
    const resolved = {
      ...initial,
      description: "Resolved documentation",
      additionalTextEdits: [
        {
          range: [
            [0, 0],
            [0, 0],
          ],
          newText: "import value\n",
        },
      ],
    };
    detail.resolve(resolved);
    await manager.pendingDetails.get(initial);
    const view = manager.suggestionList.suggestionListElement;
    view.setSelectedIndex(0);
    const callsBefore = fast.getSuggestionDetailsOnSelect.calls.count();
    slow.resolve([{ text: "atlas" }]);
    await pending;
    expect(view.getSelectedItem()).toBe(resolved);
    expect(view.getSelectedItem().additionalTextEdits).toEqual(resolved.additionalTextEdits);
    expect(fast.getSuggestionDetailsOnSelect.calls.count()).toBe(callsBefore);
  });

  it("does not replace entries in a provider-owned frozen result array when details resolve", async () => {
    const slow = deferred(),
      detail = deferred();
    provider(() => slow.promise);
    const initial = { text: "alpha" },
      cached = Object.freeze([initial]);
    provider(() => cached, { getSuggestionDetailsOnSelect: () => detail.promise });
    const pending = request();
    await visible("alpha");
    const resolved = { ...initial, description: "Resolved" };
    detail.resolve(resolved);
    await manager.pendingDetails.get(initial);
    expect(cached[0]).toBe(initial);
    slow.resolve([{ text: "atlas" }]);
    await pending;
    expect(manager.suggestionList.items).toContain(resolved);
    expect(cached[0]).toBe(initial);
  });

  it("updates details at the visible position of a choice retained beyond the cap", async () => {
    lumine.config.set("autocomplete.maxSuggestions", 2);
    const slow = deferred(),
      detail = deferred();
    provider(() => slow.promise, { suggestionPriority: 20 });
    provider(() => [{ text: "alpha" }, { text: "alpine" }], {
      getSuggestionDetailsOnSelect: (suggestion) =>
        suggestion.text === "alpine" ? detail.promise : null,
    });
    const pending = request();
    await visible("alpine");
    const view = manager.suggestionList.suggestionListElement;
    view.setSelectedIndex(1);
    const chosen = view.getSelectedItem();
    slow.resolve([{ text: "aardvark" }, { text: "atlas" }]);
    await pending;
    const resolved = { ...chosen, description: "Selected definition" };
    detail.resolve(resolved);
    await manager.pendingDetails.get(chosen);
    expect(view.getSelectedItem()).toBe(resolved);
    expect(view.descriptionSelection.item).toBe(resolved);
    expect(view.selectedIndex).toBe(1);
  });

  it("keeps the newer owner when a provider synchronously starts another request", async () => {
    const newer = deferred();
    let reentered = false,
      nested;
    provider(
      () => {
        if (reentered) return newer.promise;
        reentered = true;
        nested = request();
        return [{ text: "abandoned" }];
      },
      { suggestionPriority: 20 },
    );
    const sibling = provider(() => [{ text: "alpha" }]);
    const obsolete = request();
    await visible("alpha");
    newer.resolve([{ text: "atlas" }]);
    await Promise.all([obsolete, nested]);
    expect(manager.suggestionList.items.map((item) => item.text)).toEqual(["atlas", "alpha"]);
    expect(sibling.getSuggestions).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending manual auto-confirm when IME composition starts before a text change", async () => {
    lumine.config.set("autocomplete.enableAutoConfirmSingleSuggestion", true);
    const slow = deferred();
    let signal;
    provider((options) => {
      signal = options.signal;
      return slow.promise;
    });
    const pending = request(true);
    editor.getElement().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    expect(signal.aborted).toBe(true);
    slow.resolve([{ text: "alpha" }]);
    await pending;
    expect(editor.getText()).toBe("a");
    expect(manager.suggestionList.isActive()).toBe(false);
    editor.getElement().dispatchEvent(new Event("compositionend", { bubbles: true }));
    await request();
    expect(manager.suggestionList.isActive()).toBe(true);
  });

  it("hides an already partial list during IME and ignores the remaining provider", async () => {
    const slow = deferred();
    provider(() => slow.promise);
    provider(() => [{ text: "alpha" }]);
    const pending = request();
    await visible("alpha");
    editor.getElement().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    expect(manager.suggestionList.isActive()).toBe(false);
    slow.resolve([{ text: "atlas" }]);
    await pending;
    expect(manager.suggestionList.isActive()).toBe(false);
    editor.getElement().dispatchEvent(new Event("compositionend", { bubbles: true }));
  });

  it("does not carry an old editor's IME state into another editor", async () => {
    provider(() => [{ text: "alpha" }]);
    editor.getElement().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    const other = await lumine.workspace.open();
    try {
      other.setText("a");
      other.setCursorBufferPosition([0, 1]);
      lumine.views.getView(other).focus();
      manager.updateCurrentEditor(other, ["workspace-center"]);
      expect(manager.compositionInProgress).toBe(false);
      manager.shouldDisplaySuggestions = true;
      await manager.findSuggestions();
      expect(manager.suggestionList.activeEditor).toBe(other);
    } finally {
      other.destroy();
    }
  });

  for (const action of ["hide", "cancel", "confirm", "deactivate"]) {
    it(`does not reopen a partial menu after ${action}`, async () => {
      const slow = deferred();
      let signal;
      provider((options) => {
        signal = options.signal;
        return slow.promise;
      });
      provider(() => [{ text: "alpha" }]);
      const pending = request();
      await visible("alpha");
      const list = manager.suggestionList;
      if (action === "hide") manager.hideSuggestionList();
      if (action === "cancel") manager.cancelSuggestions();
      if (action === "confirm") await manager.confirm(manager.suggestionList.items[0]);
      if (action === "deactivate") await lumine.packages.deactivatePackage("autocomplete");
      expect(signal.aborted).toBe(true);
      slow.resolve([{ text: "atlas" }]);
      await pending;
      expect(list.isActive()).toBe(false);
      expect(editor.getText()).toBe(action === "confirm" ? "alpha" : "a");
    });
  }

  it("keeps pending confirmation details when closing the remaining provider stream", async () => {
    const slow = deferred(),
      detail = deferred();
    provider(() => slow.promise);
    provider(() => [{ text: "alpha" }], { getSuggestionDetailsOnSelect: () => detail.promise });
    const pending = request();
    await visible("alpha");
    const suggestion = manager.suggestionList.items[0];
    const confirmation = manager.confirm(suggestion);
    slow.resolve([{ text: "atlas" }]);
    await pending;
    detail.resolve({ ...suggestion, text: "alpha_resolved" });
    await confirmation;
    expect(editor.getText()).toBe("alpha_resolved");
    expect(manager.suggestionList.isActive()).toBe(false);
  });

  it("rejects a real provider error after partial publication and cancels remaining providers", async () => {
    const bad = deferred(),
      sibling = deferred();
    let signal;
    provider(() => bad.promise);
    provider((options) => {
      signal = options.signal;
      return sibling.promise;
    });
    provider(() => [{ text: "alpha" }]);
    const pending = request();
    await visible("alpha");
    const error = new Error("Provider failed");
    bad.reject(error);
    await expectAsync(pending).toBeRejectedWith(error);
    expect(signal.aborted).toBe(true);
    expect(manager.suggestionList.isActive()).toBe(false);
    sibling.resolve([{ text: "atlas" }]);
    await Promise.resolve();
    expect(manager.suggestionList.items?.some((item) => item.text === "atlas")).not.toBe(true);
  });

  it("owns a failed partial publication without waiting for an unfinished provider", async () => {
    const slow = deferred();
    let signal;
    provider((options) => {
      signal = options.signal;
      return slow.promise;
    });
    provider(() => [{ text: "alpha" }]);
    const error = new Error("Publication failed");
    spyOn(manager, "displaySuggestions").and.callFake(() => Promise.reject(error));
    const pending = request();
    await expectAsync(pending).toBeRejectedWith(error);
    expect(signal.aborted).toBe(true);
  });

  it("does not show a list cancelled synchronously by an item-change subscriber", async () => {
    const slow = deferred();
    provider(() => slow.promise);
    provider(() => [{ text: "alpha" }]);
    const list = manager.suggestionList;
    let observed = false;
    registrations.push(
      list.onDidChangeItems((items) => {
        if (items?.length) {
          observed = true;
          manager.cancelSuggestions();
        }
      }),
    );
    spyOn(list, "show").and.callThrough();
    const pending = request();
    await conditionPromise(() => observed);
    slow.resolve([{ text: "atlas" }]);
    await expectAsync(pending).toBeResolved();
    expect(list.show).not.toHaveBeenCalled();
    expect(list.isActive()).toBe(false);
  });

  it("does not show an old publication after an item-change subscriber starts a new request", async () => {
    let calls = 0,
      nested;
    provider(() => [{ text: ++calls === 1 ? "abandoned" : "active" }]);
    const list = manager.suggestionList;
    registrations.push(
      list.onDidChangeItems((items) => {
        if (items?.[0]?.text === "abandoned") nested = request();
      }),
    );
    spyOn(list, "show").and.callThrough();
    const old = request();
    await old;
    await nested;
    expect(list.items.map((item) => item.text)).toEqual(["active"]);
    expect(list.show).toHaveBeenCalledTimes(1);
    expect(list.isActive()).toBe(true);
  });
});
