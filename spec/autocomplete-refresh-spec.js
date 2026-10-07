describe("Autocomplete documentation during refresh", () => {
  let editor, editorView, mainModule, manager, view, provider, registration, details;
  let workspaceElement, workspaceHeight;
  let nextText, nextLabel, itemCount;
  const documentation =
    "Unit documentation.\n\n```python\nkN\n```\n\n" +
    "A paragraph describing this unit.\n\n".repeat(30);
  const frames = async (count = 4) => {
    for (let index = 0; index < count; index++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  };
  const type = async (text) => {
    editor.insertText(text);
    await manager.findSuggestions.calls.mostRecent().returnValue;
    view = manager.suggestionList.suggestionListElement;
    await frames();
  };
  const finishDetails = async (index, patch = {}) => {
    const request = details[index];
    const pending = manager.pendingDetails.get(request.suggestion);
    request.resolve({ ...request.suggestion, ...patch });
    await pending;
    await frames();
  };
  const openDocumentedList = async (patch = {}) => {
    await type("k");
    await finishDetails(0, { descriptionMarkdown: documentation, ...patch });
    expect(view.descriptionContainer.style.display).toBe("block");
  };

  beforeEach(async () => {
    view = null;
    jasmine.useRealClock();
    if (jasmine.isSpy(lumine.views.readDocument)) lumine.views.readDocument.and.callThrough();
    if (jasmine.isSpy(lumine.views.updateDocument)) lumine.views.updateDocument.and.callThrough();
    lumine.config.set("autocomplete.enableAutoActivation", false);
    lumine.config.set("autocomplete.autoActivationDelay", 0);
    lumine.config.set("autocomplete.minimumWordLength", 1);
    lumine.config.set("autocomplete.similarSuggestionRemoval", "none");
    workspaceElement = lumine.views.getView(lumine.workspace);
    workspaceHeight = workspaceElement.style.height;
    workspaceElement.style.height = `${window.innerHeight}px`;
    jasmine.attachToDOM(workspaceElement);
    editor = await lumine.workspace.open("");
    editorView = lumine.views.getView(editor);
    editorView.setUpdatedSynchronously(false);
    editor.insertText("\n".repeat(200));
    editor.scrollToCursorPosition();
    editorView.focus();
    mainModule = (await lumine.packages.activatePackage("autocomplete")).mainModule;
    manager = mainModule.autocompleteManager;
    details = [];
    nextText = "kN";
    nextLabel = undefined;
    itemCount = 1;
    provider = {
      scopeSelector: "*",
      inclusionPriority: 2,
      excludeLowerPriority: true,
      getSuggestions({ prefix, bufferPosition }) {
        return Array.from({ length: itemCount }, () => ({
          text: nextText,
          type: "variable",
          rightLabel: nextLabel,
          replacementPrefix: prefix,
          textEdit: {
            range: [[bufferPosition.row, 0], bufferPosition],
            newText: nextText,
          },
        }));
      },
      getSuggestionDetailsOnSelect(suggestion) {
        return new Promise((resolve) => details.push({ suggestion, resolve }));
      },
    };
    registration = mainModule.consumeAutocomplete(provider);
    spyOn(manager, "findSuggestions").and.callThrough();
    lumine.config.set("autocomplete.enableAutoActivation", true);
    await frames();
  });

  afterEach(async () => {
    manager.cancelSuggestions();
    registration.dispose();
    workspaceElement.style.height = workspaceHeight;
    await frames(2);
  });

  it("keeps the same documentation and overlay geometry while kN details are fetched again", async () => {
    await openDocumentedList();
    const codeElement = view.descriptionContent.querySelector("lumine-text-editor");
    const codeEditor = codeElement.getModel();
    const overlay = editorView.querySelector(".autocomplete");
    const before = {
      ...view.element.getBoundingClientRect().toJSON(),
      top: overlay.getBoundingClientRect().top,
    };
    const samples = [];
    let frame;
    const sample = () => {
      if (view.element.isConnected) {
        samples.push({
          visible: view.descriptionContainer.style.display,
          height: view.element.getBoundingClientRect().height,
          top: overlay.getBoundingClientRect().top,
        });
      }
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    try {
      await type("N");
      await frames(6);

      expect(details.length).toBe(2);
      expect(manager.suggestionList.items[0].descriptionMarkdown).toBeUndefined();
      expect(manager.suggestionList.items[0].textEdit.range[1].column).toBe(2);
      expect(samples.length).toBeGreaterThan(1);
      for (const entry of samples) {
        expect(entry.visible).toBe("block");
        expect(entry.height).toBeCloseTo(before.height, 0);
        expect(entry.top).toBeCloseTo(before.top, 0);
      }
      expect(view.descriptionContent.querySelector("lumine-text-editor")).toBe(codeElement);
      expect(codeEditor.isDestroyed()).toBe(false);

      await finishDetails(1, { descriptionMarkdown: documentation });
      expect(view.descriptionContent.querySelector("lumine-text-editor")).toBe(codeElement);
      expect(codeEditor.isDestroyed()).toBe(false);
    } finally {
      cancelAnimationFrame(frame);
    }
  });

  it("compares the original identity when resolve has added a label", async () => {
    await openDocumentedList({ leftLabel: "Resolved unit type" });
    await type("N");

    expect(view.descriptionContainer.style.display).toBe("block");
    expect(view.descriptionContent.textContent).toContain("Unit documentation.");
  });

  it("replaces the retained documentation when the new resolve changes it", async () => {
    await openDocumentedList();
    await type("N");
    await finishDetails(1, { description: "Updated unit documentation." });

    expect(view.descriptionContent.textContent).toBe("Updated unit documentation.");
  });

  it("removes retained documentation when the new resolve explicitly has none", async () => {
    await openDocumentedList();
    await type("N");
    await finishDetails(1);

    expect(view.descriptionContainer.style.display).toBe("none");
    expect(view.descriptionContent.childElementCount).toBe(0);
  });

  it("keeps known documentation when a refresh resolve supplies no update", async () => {
    await openDocumentedList();
    await type("N");
    const request = details[1];
    const pending = manager.pendingDetails.get(request.suggestion);
    request.resolve(null);
    await pending;
    await frames();

    expect(view.descriptionContainer.style.display).toBe("block");
    expect(view.descriptionContent.textContent).toContain("Unit documentation.");
    expect(manager.suggestionList.items[0].descriptionMarkdown).toBeUndefined();
  });

  for (const change of ["symbol", "module", "provider"]) {
    it(`clears old documentation when the selected ${change} changes`, async () => {
      await openDocumentedList();
      if (change === "symbol") nextText = "knownfiles";
      if (change === "module") nextLabel = "another_module";
      if (change === "provider") {
        registration.dispose();
        registration = mainModule.consumeAutocomplete({ ...provider });
      }
      await type("N");

      expect(view.descriptionContainer.style.display).toBe("none");
      expect(view.descriptionContent.textContent).not.toContain("Unit documentation.");
    });
  }

  for (const [oldCount, newCount] of [
    [1, 2],
    [2, 1],
  ]) {
    it(`does not retain ambiguous documentation across ${oldCount} to ${newCount} matching items`, async () => {
      itemCount = oldCount;
      await openDocumentedList();
      itemCount = newCount;
      await type("N");

      expect(view.descriptionContainer.style.display).toBe("none");
    });
  }

  it("clears old documentation when the popup is dismissed and reopened", async () => {
    await openDocumentedList();
    manager.cancelSuggestions();
    await frames();
    await type("N");

    expect(view.descriptionContainer.style.display).toBe("none");
    expect(view.descriptionContent.textContent).not.toContain("Unit documentation.");
  });

  it("does not retain the same symbol's documentation after moving to another word", async () => {
    await openDocumentedList();
    await type(" ");

    expect(view.descriptionContainer.style.display).toBe("none");
    expect(view.descriptionContent.textContent).not.toContain("Unit documentation.");
  });

  it("does not retain documentation when a reused raw suggestion changes its symbol", async () => {
    await openDocumentedList();
    const raw = details[0].suggestion;
    provider.getSuggestions = ({ prefix, bufferPosition }) => {
      raw.text = "knownfiles";
      raw.replacementPrefix = prefix;
      raw.textEdit = { range: [[bufferPosition.row, 0], bufferPosition], newText: raw.text };
      return [raw];
    };
    await type("N");

    expect(view.descriptionContainer.style.display).toBe("none");
    expect(view.descriptionContent.textContent).not.toContain("Unit documentation.");
  });

  describe("between selected suggestions", () => {
    beforeEach(() => {
      itemCount = 3;
      const getSuggestions = provider.getSuggestions;
      provider.getSuggestions = (options) =>
        getSuggestions(options).map((item, index) => {
          const text = ["kN", "kPa", "kJ"][index];
          return { ...item, text, textEdit: { ...item.textEdit, newText: text } };
        });
    });

    it("replaces quickly resolved documentation without a collapsed browser frame", async () => {
      await openDocumentedList({ descriptionMoreURL: "https://example.com/first" });
      const codeElement = view.descriptionContent.querySelector("lumine-text-editor");
      const codeEditor = codeElement.getModel();
      const beforeHeight = view.element.getBoundingClientRect().height;
      const samples = [];
      let frame;
      const sample = () => {
        samples.push({
          visible: view.descriptionContainer.style.display,
          height: view.element.getBoundingClientRect().height,
        });
        frame = requestAnimationFrame(sample);
      };
      frame = requestAnimationFrame(sample);
      const openExternal = spyOn(lumine.shell, "openExternal").and.resolveTo();
      try {
        view.setSelectedIndex(1);
        await frames(1);
        expect(view.selectedIndex).toBe(1);
        expect(view.descriptionContent.querySelector("lumine-text-editor")).toBe(codeElement);
        expect(codeEditor.isDestroyed()).toBe(false);
        lumine.commands.dispatch(editorView, "autocomplete:navigate-to-description-more-link");
        expect(openExternal).not.toHaveBeenCalled();

        await finishDetails(1, {
          descriptionMarkdown: documentation.replace(
            "Unit documentation.",
            "Second unit documentation.",
          ),
          descriptionMoreURL: "https://example.com/second",
        });

        expect(samples.length).toBeGreaterThan(1);
        for (const entry of samples) {
          expect(entry.visible).toBe("block");
          expect(entry.height).toBeCloseTo(beforeHeight, 0);
        }
        expect(view.descriptionContent.textContent).toContain("Second unit documentation.");
        expect(codeEditor.isDestroyed()).toBe(true);
        lumine.commands.dispatch(editorView, "autocomplete:navigate-to-description-more-link");
        expect(openExternal).toHaveBeenCalledOnceWith("https://example.com/second");
      } finally {
        cancelAnimationFrame(frame);
      }
    });
  });

  describe("first presentation near the bottom of the window", () => {
    const placeCaret = async () => {
      const lineHeight = editorView.getComponent().getLineHeight();
      const targetRow = Math.floor(
        (window.innerHeight - 140 - editorView.getBoundingClientRect().top) / lineHeight,
      );
      editor.setCursorBufferPosition([targetRow, 0]);
      editorView.setScrollTop(0);
      await frames();
    };
    const samplePresentation = () => {
      const entries = [];
      let frame;
      const sample = () => {
        const overlay = view?.element.closest("lumine-overlay");
        if (overlay && getComputedStyle(overlay).visibility === "visible") {
          entries.push({
            side: overlay.dataset.overlayPosition,
            top: overlay.getBoundingClientRect().top,
            height: view.element.getBoundingClientRect().height,
          });
        }
        frame = requestAnimationFrame(sample);
      };
      frame = requestAnimationFrame(sample);
      return { entries, stop: () => cancelAnimationFrame(frame) };
    };
    const beginTyping = async () => {
      editor.insertText("k");
      await manager.findSuggestions.calls.mostRecent().returnValue;
      view = manager.suggestionList.suggestionListElement;
    };
    const expectFinalPosition = (entries) => {
      expect(entries.length).toBeGreaterThan(1);
      const final = entries[entries.length - 1];
      for (const entry of entries) {
        expect(entry.side).toBe("above");
        expect(entry.top).toBeCloseTo(final.top, 0);
        expect(entry.height).toBeCloseTo(final.height, 0);
      }
    };

    it("shows ready documentation immediately in its final position", async () => {
      await placeCaret();
      const getSuggestions = provider.getSuggestions;
      provider.getSuggestions = (options) =>
        getSuggestions(options).map((item) => ({ ...item, descriptionMarkdown: documentation }));
      const sampling = samplePresentation();
      try {
        await beginTyping();
        await frames(8);
        expectFinalPosition(sampling.entries);
      } finally {
        sampling.stop();
      }
    });

    it("fits a newly mounted popup after a cold horizontal pixel cache forces an early editor update", async () => {
      await placeCaret();
      const getSuggestions = provider.getSuggestions;
      provider.getSuggestions = (options) =>
        getSuggestions(options).map((item) => ({ ...item, descriptionMarkdown: documentation }));
      const list = manager.suggestionList;
      const showList = list.show;
      spyOn(list, "show").and.callFake((...args) => {
        editorView.getComponent().horizontalPixelPositionsByScreenLineId.clear();
        return showList(...args);
      });
      const sampling = samplePresentation();
      try {
        await beginTyping();
        await frames(8);
        expectFinalPosition(sampling.entries);
        expect(view.element.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
      } finally {
        sampling.stop();
      }
    });

    it("does not paint a below-cursor popup before quick documentation moves it above", async () => {
      await placeCaret();
      const sampling = samplePresentation();
      try {
        await beginTyping();
        await frames(2);
        await finishDetails(0, { descriptionMarkdown: documentation });
        await frames(4);
        expectFinalPosition(sampling.entries);
      } finally {
        sampling.stop();
      }
    });

    it("keeps the list usable after a bounded wait when details do not arrive", async () => {
      await placeCaret();
      await beginTyping();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await frames();
      const overlay = view.element.closest("lumine-overlay");

      expect(getComputedStyle(overlay).visibility).toBe("visible");
      expect(manager.suggestionList.isActive()).toBe(true);
      expect(view.ol.querySelector(".word").textContent).toBe("kN");
      expect(overlay.dataset.overlayPosition).toBe("above");
      await finishDetails(0, { descriptionMarkdown: documentation });
      expect(overlay.dataset.overlayPosition).toBe("above");
    });

    it("keeps the usual below-cursor position when a quick resolve has no documentation", async () => {
      await placeCaret();
      provider.getSuggestionDetailsOnSelect = (suggestion) => suggestion;
      await beginTyping();
      await frames(6);
      const overlay = view.element.closest("lumine-overlay");

      expect(getComputedStyle(overlay).visibility).toBe("visible");
      expect(overlay.dataset.overlayPosition).toBe("below");
      expect(view.descriptionContainer.style.display).toBe("none");
    });

    it("does not reveal a cancelled initial presentation when its timer or details finish", async () => {
      await placeCaret();
      await beginTyping();
      await frames(1);
      manager.cancelSuggestions();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await finishDetails(0, { descriptionMarkdown: documentation });

      expect(editorView.querySelector(".autocomplete")).toBeNull();
      expect(manager.suggestionList.isActive()).toBe(false);
    });

    it("does not reveal a new selection through the previous selection's queued resolve", async () => {
      await placeCaret();
      itemCount = 2;
      await beginTyping();
      await frames(1);
      const request = details[0];
      const pending = manager.pendingDetails.get(request.suggestion);
      request.resolve({ ...request.suggestion, descriptionMarkdown: documentation });
      await pending;
      view.setSelectedIndex(1);
      await frames(1);

      const overlay = view.element.closest("lumine-overlay");
      expect(getComputedStyle(overlay).visibility).toBe("hidden");
      await finishDetails(1, { description: "Selected second completion." });
      expect(getComputedStyle(overlay).visibility).toBe("visible");
      expect(view.descriptionContent.textContent).toBe("Selected second completion.");
    });
  });
});
