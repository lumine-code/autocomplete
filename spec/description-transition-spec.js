const SuggestionList = require("../lib/suggestion-list");
require("./spec-helper");

describe("Autocomplete documentation during selection", () => {
  let model, view, provider, first, second, third;
  const description = "Documentation for the first completion.";
  const moreURL = "https://example.com/first";
  const runDocumentUpdate = (callback) => callback();

  const expectPendingDescription = () => {
    expect(view.descriptionContainer.style.display).toBe("block");
    expect(view.descriptionContent.textContent).toBe(description);
    expect(view.descriptionContainer.inert).toBe(true);
    expect(view.descriptionContainer.getAttribute("aria-busy")).toBe("true");
  };
  const expectEmptyDescription = () => {
    expect(view.descriptionContainer.style.display).toBe("none");
    expect(view.descriptionContent.childElementCount).toBe(0);
    expect(view.descriptionContent.textContent).toBe("");
    expect(view.descriptionContainer.inert).toBe(false);
    expect(view.descriptionContainer.hasAttribute("aria-busy")).toBe(false);
  };

  beforeEach(() => {
    lumine.config.set("autocomplete.maxVisibleSuggestions", 10);
    lumine.config.set("autocomplete.maxSuggestions", 200);
    const grammar = {};
    model = new SuggestionList();
    model.initialize();
    model.activeEditor = {
      getCursorBufferPosition: () => ({ row: 0, column: 1 }),
      getGrammar: () => grammar,
    };
    view = model.suggestionListElement;
    jasmine.attachToDOM(view.element);
    provider = { getSuggestionDetailsOnSelect() {} };
    first = { text: "first", provider, description, descriptionMoreURL: moreURL };
    second = { text: "second", provider };
    third = { text: "third", provider };
    model.changeItems([first, second, third]);
  });

  afterEach(() => {
    model?.dispose();
    model = null;
  });

  it("keeps the previous documentation for at most 150 ms while selected details are pending", () => {
    view.setSelectedIndex(1);
    expectPendingDescription();
    expect(view.descriptionMoreLink.getAttribute("href")).toBe(moreURL);
    advanceClock(149);
    expectPendingDescription();
    advanceClock(1);
    expectEmptyDescription();
  });

  it("replaces held documentation as soon as the selected details arrive", () => {
    view.setSelectedIndex(1);
    advanceClock(50);
    model.replaceItem(second, {
      ...second,
      description: "Documentation for the second completion.",
    });

    expect(view.descriptionContainer.style.display).toBe("block");
    expect(view.descriptionContent.textContent).toBe("Documentation for the second completion.");
    expect(view.descriptionContainer.inert).toBe(false);
    expect(view.descriptionContainer.hasAttribute("aria-busy")).toBe(false);
    advanceClock(200);
    expect(view.descriptionContent.textContent).toBe("Documentation for the second completion.");
  });

  it("clears held documentation immediately when the selected resolve explicitly has none", () => {
    view.setSelectedIndex(1);
    expectPendingDescription();
    advanceClock(20);
    model.replaceItem(second, { ...second });
    expectEmptyDescription();
  });

  it("does not wait for a completion whose provider cannot resolve documentation", () => {
    second.provider = {};
    view.setSelectedIndex(1);
    expectEmptyDescription();
  });

  it("keeps the latest selection's grace period through rapid movement and an earlier resolve", () => {
    view.setSelectedIndex(1);
    advanceClock(100);
    view.setSelectedIndex(2);
    advanceClock(50);
    expectPendingDescription();
    model.replaceItem(second, { ...second, description: "Late second documentation." });
    expectPendingDescription();
    advanceClock(99);
    expectPendingDescription();
    advanceClock(1);
    expectEmptyDescription();
  });

  it("does not overwrite the latest resolved description with an earlier response or timer", () => {
    view.setSelectedIndex(1);
    advanceClock(50);
    view.setSelectedIndex(2);
    model.replaceItem(third, { ...third, description: "Third documentation." });
    model.replaceItem(second, { ...second, description: "Late second documentation." });
    advanceClock(300);

    expect(view.descriptionContent.textContent).toBe("Third documentation.");
    expect(view.descriptionContainer.inert).toBe(false);
  });

  it("makes identical documentation and its More link usable when the new selection resolves", () => {
    view.setSelectedIndex(1);
    expectPendingDescription();
    model.replaceItem(second, { ...second, description, descriptionMoreURL: moreURL });

    expect(view.descriptionContent.textContent).toBe(description);
    expect(view.descriptionContainer.inert).toBe(false);
    expect(view.descriptionContainer.hasAttribute("aria-busy")).toBe(false);
    expect(view.descriptionMoreLink.style.display).toBe("inline");
    expect(view.descriptionMoreLink.getAttribute("href")).toBe(moreURL);
    advanceClock(200);
    expect(view.descriptionContainer.style.display).toBe("block");
  });

  it("restores an already documented selection and cancels the intervening timer", () => {
    view.setSelectedIndex(1);
    advanceClock(50);
    view.setSelectedIndex(0);

    expect(view.descriptionContent.textContent).toBe(description);
    expect(view.descriptionContainer.inert).toBe(false);
    expect(view.descriptionContainer.hasAttribute("aria-busy")).toBe(false);
    expect(view.descriptionMoreLink.style.display).toBe("inline");
    expect(view.descriptionMoreLink.getAttribute("href")).toBe(moreURL);
    advanceClock(200);
    expect(view.descriptionContainer.style.display).toBe("block");
  });

  for (const outcome of ["selected resolve", "return to a ready selection", "refresh"]) {
    it(`keeps held links inert until queued document writes commit on ${outcome}`, () => {
      view.setSelectedIndex(1);
      expectPendingDescription();
      const writes = [];
      const reads = [];
      lumine.views.updateDocument.and.callFake((callback) => writes.push(callback));
      lumine.views.readDocument.and.callFake((callback) => reads.push(callback));
      const nextDescription = "Documentation for the next completion.";
      const nextURL = "https://example.com/next";
      if (outcome === "selected resolve") {
        model.replaceItem(second, {
          ...second,
          description: nextDescription,
          descriptionMoreURL: nextURL,
        });
      } else if (outcome === "return to a ready selection") {
        view.setSelectedIndex(0);
      } else {
        model.changeItems([
          { ...third, description: nextDescription, descriptionMoreURL: nextURL },
        ]);
      }

      expect(writes.length).toBeGreaterThan(0);
      expectPendingDescription();
      expect(view.descriptionMoreLink.getAttribute("href")).toBe(moreURL);

      lumine.views.updateDocument.and.callFake(runDocumentUpdate);
      for (const callback of writes) callback();
      const returning = outcome === "return to a ready selection";
      expect(view.descriptionContainer.style.display).toBe("block");
      expect(view.descriptionContent.textContent).toBe(returning ? description : nextDescription);
      expect(view.descriptionMoreLink.getAttribute("href")).toBe(returning ? moreURL : nextURL);
      expect(view.descriptionContainer.inert).toBe(false);
      expect(view.descriptionContainer.hasAttribute("aria-busy")).toBe(false);
      lumine.views.readDocument.and.callFake(runDocumentUpdate);
      for (const callback of reads) callback();
      advanceClock(200);
      expect(view.descriptionContent.textContent).toBe(returning ? description : nextDescription);
    });
  }

  it("ignores an expiry already queued for a selection that has changed", () => {
    view.setSelectedIndex(1);
    const writes = [];
    lumine.views.updateDocument.and.callFake((callback) => writes.push(callback));
    advanceClock(150);
    expect(writes.length).toBeGreaterThan(0);
    lumine.views.updateDocument.and.callFake(runDocumentUpdate);
    view.setSelectedIndex(0);
    for (const callback of writes) callback();

    expect(view.descriptionContainer.style.display).toBe("block");
    expect(view.descriptionContent.textContent).toBe(description);
    expect(view.descriptionContainer.inert).toBe(false);
  });

  it("does not retain the previous symbol's documentation when a pending selection is refreshed", () => {
    view.setSelectedIndex(1);
    expectPendingDescription();
    const refreshed = { ...second };
    model.changeItems([refreshed]);
    expectEmptyDescription();
    advanceClock(200);
    expectEmptyDescription();
    model.replaceItem(refreshed, { ...refreshed, description: "Refreshed second documentation." });
    expect(view.descriptionContent.textContent).toBe("Refreshed second documentation.");
  });

  it("does not restore held documentation after dismissal, a late response, or reopening", () => {
    view.setSelectedIndex(1);
    model.changeItems(null);
    model.replaceItem(second, { ...second, description: "Late second documentation." });
    advanceClock(300);
    expectEmptyDescription();
    model.changeItems([{ ...third }]);
    expectEmptyDescription();
  });

  it("does not restore held documentation after disposal with an expiry already queued", () => {
    view.setSelectedIndex(1);
    const writes = [];
    lumine.views.updateDocument.and.callFake((callback) => writes.push(callback));
    advanceClock(150);
    lumine.views.updateDocument.and.callFake(runDocumentUpdate);
    model.dispose();
    model = null;
    for (const callback of writes) callback();

    expect(view.element.isConnected).toBe(false);
    expect(view.descriptionContent.childElementCount).toBe(0);
    expect(view.descriptionContent.textContent).toBe("");
    expect(view.descriptionContainer.inert).toBe(false);
  });

  for (const outcome of ["replacement", "expiry", "dismissal"]) {
    it(`keeps the previous code editor alive during the wait and destroys it on ${outcome}`, () => {
      first = {
        text: "first",
        provider,
        descriptionMarkdown: "```js\nfirst()\n```",
      };
      model.changeItems([first, second, third]);
      const codeElement = view.descriptionContent.querySelector("lumine-text-editor");
      const codeEditor = codeElement.getModel();
      view.setSelectedIndex(1);
      advanceClock(149);

      expect(view.descriptionContent.querySelector("lumine-text-editor")).toBe(codeElement);
      expect(codeEditor.isDestroyed()).toBe(false);
      if (outcome === "replacement") {
        model.replaceItem(second, { ...second, description: "Second documentation." });
      } else if (outcome === "expiry") {
        advanceClock(1);
      } else {
        model.changeItems(null);
      }
      expect(codeEditor.isDestroyed()).toBe(true);
      expect(view.descriptionContent.querySelector("lumine-text-editor")).toBeNull();
    });
  }
});
