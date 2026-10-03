describe("Autocomplete popup layout", () => {
  let editor, editorView, manager, list, view;

  const frames = async (count = 4) => {
    for (let index = 0; index < count; index++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  };
  const show = (items) => {
    list.changeItems(items);
    list.show(editor, { prefix: "k" });
    view = list.suggestionListElement;
  };
  const suggestions = (count = 30) =>
    Array.from({ length: count }, (_, index) => ({
      text: `keyword${index}`,
      type: "variable",
      replacementPrefix: "k",
      leftLabel: "Auto-import",
      rightLabel: "module",
    }));
  const geometry = () => {
    const rect = view.element.getBoundingClientRect();
    const word = view.ol.querySelector(".word-container").getBoundingClientRect();
    return { width: rect.width, height: rect.height, left: rect.left, word: word.left };
  };

  beforeEach(async () => {
    view = null;
    jasmine.useRealClock();
    // The shared spec helper replaces the schedulers with immediate calls.
    // Layout regressions need the real document update and browser frames.
    if (jasmine.isSpy(lumine.views.readDocument)) lumine.views.readDocument.and.callThrough();
    if (jasmine.isSpy(lumine.views.updateDocument)) lumine.views.updateDocument.and.callThrough();
    lumine.config.set("autocomplete.enableAutoActivation", false);
    lumine.config.set("autocomplete.maxVisibleSuggestions", 10);
    lumine.config.set("autocomplete.suggestionListFollows", "Word");
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    editor = await lumine.workspace.open("");
    editorView = lumine.views.getView(editor);
    editorView.setUpdatedSynchronously(false);
    editor.insertText("k");
    editorView.focus();
    const pack = await lumine.packages.activatePackage("autocomplete");
    manager = pack.mainModule.autocompleteManager;
    list = manager.suggestionList;
    await frames();
  });

  afterEach(async () => {
    manager.cancelNewSuggestionsRequest();
    list.hide();
    await frames(2);
  });

  it("keeps the popup and word column in place when wider deferred rows are rendered", async () => {
    const items = suggestions();
    items[items.length - 1].text = "keyword_with_a_much_longer_name_than_the_visible_rows";
    items[items.length - 1].rightLabel = "a_longer_module_name";
    items[items.length - 1].leftLabel = "Imported from a much longer module name";
    items[items.length - 1].displayTextDetail = "(first_argument: string, second_argument: string)";
    show(items);
    await frames();
    const before = geometry();
    expect(
      Math.abs(
        parseFloat(view.element.style.marginLeft) +
          view.ol.firstChild.querySelector(".word-container").offsetLeft,
      ),
    ).toBeLessThan(1);

    view.scroller.scrollTop = view.ol.firstChild.offsetHeight;
    await frames(8);

    expect(view.ol.childNodes.length).toBe(items.length);
    const after = geometry();
    expect(after.width).toBeCloseTo(before.width, 0);
    expect(after.left).toBeCloseTo(before.left, 0);
    expect(after.word).toBeCloseTo(before.word, 0);
    expect(view.ol.lastChild.offsetHeight).toBe(view.ol.firstChild.offsetHeight);
  });

  it("does not render deferred completion rows when only documentation is scrolled", async () => {
    const items = suggestions();
    items[0].descriptionMarkdown = Array.from(
      { length: 40 },
      (_, index) => `Paragraph ${index}.`,
    ).join("\n\n");
    items[items.length - 1].text = "keyword_with_a_much_longer_name_than_the_visible_rows";
    show(items);
    await frames();
    const before = geometry();
    const rowCount = view.ol.childNodes.length;

    view.descriptionContent.scrollTop = 40;
    await frames(8);

    expect(view.descriptionContent.scrollTop).toBeGreaterThan(0);
    expect(view.ol.childNodes.length).toBe(rowCount);
    expect(geometry().width).toBeCloseTo(before.width, 0);
  });

  for (const count of [6, 30]) {
    it(`keeps a consistent icon gap without labels before and after details resolve (${count} rows)`, async () => {
      const words = ["page", "Page", "Passenger", "spacing", "prevailing", "accompanying"];
      const items = Array.from({ length: count }, (_, index) => ({
        text: words[index] || `buffer_word_${index}`,
        type: index < 2 ? "variable" : undefined,
        replacementPrefix: "k",
      }));
      const expectGap = (stage) => {
        for (const index of [0, 1]) {
          const row = view.ol.childNodes[index];
          const cell = row.querySelector(".icon-container");
          const icon = cell.querySelector(".icon").getBoundingClientRect();
          const word = row.querySelector(".word").getBoundingClientRect();
          const padding = parseFloat(getComputedStyle(cell).paddingRight);
          expect(word.left - icon.right)
            .withContext(`${stage}, row ${index}`)
            .toBeCloseTo(padding, 0);
        }
        const wordPositions = Array.from(
          view.ol.children,
          (row) => row.querySelector(".word").getBoundingClientRect().left,
        );
        expect(Math.max(...wordPositions) - Math.min(...wordPositions)).toBeLessThan(1);
      };
      show(items);
      await frames();
      const before = geometry();
      expectGap("initial");

      list.replaceItem(items[0], { ...items[0], description: "Resolved page documentation." });
      await frames();

      expectGap("resolved");
      expect(geometry().word).toBeCloseTo(before.word, 0);
      expect(geometry().width).toBeCloseTo(before.width, 0);
    });
  }

  it("keeps a small icon gap when documentation makes the popup wider than its rows", async () => {
    const words = [
      "section",
      "Section",
      "sectional",
      "sections",
      "EffSectionWidth",
      "Inspection",
      "inspection",
    ];
    const items = words.map((text, index) => ({
      text,
      type: index < 2 ? "variable" : undefined,
      description: index === 0 ? "LongDocumentationWord".repeat(5) : undefined,
      replacementPrefix: "k",
    }));
    show(items);
    await frames();
    expect(geometry().width).toBeGreaterThan(450);
    view.setSelectedIndex(3);
    await frames();
    list.replaceItem(items[0], { ...items[0], description: "Resolved section documentation." });
    await frames();

    const row = view.ol.firstChild;
    const cell = row.querySelector(".icon-container");
    const icon = cell.querySelector(".icon").getBoundingClientRect();
    const word = row.querySelector(".word").getBoundingClientRect();
    expect(word.left - icon.right).toBeCloseTo(parseFloat(getComputedStyle(cell).paddingRight), 0);
  });

  it("drops old label widths when pooled rows reopen with no labels", async () => {
    show([
      {
        text: "old",
        type: "variable",
        leftLabel: "Long previous annotation",
        replacementPrefix: "k",
      },
    ]);
    await frames();
    list.changeItems(null);
    list.hide();
    await frames();
    show([
      { text: "section", type: "variable", replacementPrefix: "k" },
      { text: "Section", type: "variable", replacementPrefix: "k" },
      { text: "sectional", replacementPrefix: "k" },
      { text: "sections", replacementPrefix: "k" },
    ]);
    await frames();

    const row = view.ol.firstChild;
    const cell = row.querySelector(".icon-container");
    const icon = cell.querySelector(".icon").getBoundingClientRect();
    const word = row.querySelector(".word").getBoundingClientRect();
    expect(word.left - icon.right).toBeCloseTo(parseFloat(getComputedStyle(cell).paddingRight), 0);
    expect(row.querySelector(".left-label").clientWidth).toBe(0);
  });

  it("reserves columns for icons and labels that occur only in deferred rows", async () => {
    const items = suggestions().map(({ text, replacementPrefix }) => ({ text, replacementPrefix }));
    items[items.length - 1] = {
      ...items[items.length - 1],
      type: "function",
      leftLabel: "Auto-import",
      rightLabel: "later_module",
    };
    show(items);
    await frames();
    const before = geometry();
    expect(view.ol.querySelector(".sizing-row")).toBeNull();
    view.scroller.scrollTop = view.ol.firstChild.offsetHeight;
    await frames(8);

    const row = view.ol.lastChild;
    const icon = row.querySelector(".icon").getBoundingClientRect();
    const label = row.querySelector(".left-label").getBoundingClientRect();
    expect(row.querySelector(".left-label").clientWidth).toBeGreaterThan(30);
    expect(row.querySelector(".right-label").clientWidth).toBeGreaterThan(30);
    expect(icon.right).toBeLessThanOrEqual(label.left + 1);
    expect(geometry().width).toBeCloseTo(before.width, 0);
    expect(geometry().word).toBeCloseTo(before.word, 0);
  });

  it("never inserts another suggestion's documentation while opening", async () => {
    view = list.suggestionListElement;
    await frames();
    const items = suggestions(2);
    items[0].descriptionMarkdown = "Selected documentation.\n\n```python\nk = 1\n```";
    items[1].descriptionMarkdown = "UNSELECTED_DOCUMENTATION ".repeat(40);
    const inserted = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        inserted.push(...Array.from(record.addedNodes, (node) => node.textContent));
      }
    });
    observer.observe(view.descriptionContent, { childList: true });
    try {
      show(items);
      await frames(8);

      expect(inserted.join("\n")).not.toContain("UNSELECTED_DOCUMENTATION");
      expect(view.descriptionContent.textContent).toContain("Selected documentation.");
    } finally {
      observer.disconnect();
    }
  });

  it("uses the editor font throughout a provider-rendered documentation code block", async () => {
    const items = suggestions(1);
    items[0].descriptionMarkdown = "```python\ndef section(...) -> Section\n```";
    items[0].descriptionCodeBlockRenderer = async ({ text }) => {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      const span = document.createElement("span");
      span.className = "syntax--source syntax--python";
      span.textContent = text;
      code.appendChild(span);
      pre.appendChild(code);
      return pre;
    };
    show(items);
    view.element.style.setProperty("--editor-font-size", "18px");
    view.element.style.setProperty("--editor-font-family", "monospace");
    await frames();
    const pre = view.descriptionContent.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(getComputedStyle(pre).fontSize).toBe("18px");
    expect(getComputedStyle(pre.querySelector("code")).fontSize).toBe("18px");
    expect(getComputedStyle(pre.querySelector("span")).fontSize).toBe("18px");
    expect(getComputedStyle(pre.querySelector("code")).fontFamily).toBe("monospace");
  });

  it("preserves the embedded code editor when unchanged documentation is measured again", async () => {
    const items = suggestions(2);
    items[0].descriptionMarkdown = "Selected documentation.\n\n```python\nk = 1\n```";
    show(items);
    await frames(8);
    const codeElement = view.descriptionContent.querySelector("lumine-text-editor");
    expect(codeElement).not.toBeNull();
    const codeEditor = codeElement.getModel();

    lumine.views.readDocument(() => view.readUIPropsFromDOM());
    await frames();

    expect(view.descriptionContent.querySelector("lumine-text-editor")).toBe(codeElement);
    expect(codeEditor.isDestroyed()).toBe(false);
  });

  it("removes old deferred rows and resets scrolling when the list is replaced", async () => {
    show(suggestions(40));
    await frames();
    view.scroller.scrollTop = view.ol.firstChild.offsetHeight;
    await frames(8);
    expect(view.ol.childNodes.length).toBe(40);
    view.scroller.scrollTop = 200;
    await frames(2);

    const items = suggestions(30).map((item) => ({ ...item, text: `new_${item.text}` }));
    show(items);
    await frames();

    expect(view.scroller.scrollTop).toBe(0);
    expect(view.ol.childNodes.length).toBe(11);
    expect(view.ol.textContent).not.toContain("keyword11");
    expect(view.ol.firstChild.classList.contains("selected")).toBe(true);
  });

  it("renders a preselected deferred row before the popup is shown", async () => {
    const items = suggestions();
    items[20].preselect = true;
    items[20].description = "Preselected documentation.";
    show(items);
    await frames();

    expect(view.selectedIndex).toBe(20);
    expect(view.ol.childNodes[20]).toBeDefined();
    expect(view.ol.childNodes[20]?.classList.contains("selected")).toBe(true);
    expect(view.descriptionContent.textContent).toBe("Preselected documentation.");
  });

  it("keeps row indexes when deferred selection is queued before layout measurement", async () => {
    show(suggestions());
    await frames();
    const items = suggestions().map((item) => ({ ...item, text: `new_${item.text}` }));
    list.changeItems(items);
    view.setSelectedIndex(11);
    await frames(8);

    expect(view.ol.childNodes.length).toBe(items.length);
    expect(view.ol.querySelector(".sizing-row")).toBeNull();
    expect(Array.from(view.ol.children, (row) => row.querySelector(".word").textContent)).toEqual(
      items.map((item) => item.text),
    );
    expect(view.ol.childNodes[11].classList.contains("selected")).toBe(true);
  });

  it("opens with stable geometry across browser frames with markdown code blocks", async () => {
    const items = suggestions();
    items[0].descriptionMarkdown = "Selected documentation.\n\n```python\nk = 1\n```";
    const samples = [];
    let frame;
    const sample = () => {
      if (view?.element.isConnected && view.ol.childNodes.length) samples.push(geometry());
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    try {
      show(items);
      await frames(12);

      expect(samples.length).toBeGreaterThan(1);
      for (const prop of ["width", "height", "left", "word"]) {
        const values = samples.map((entry) => entry[prop]);
        expect(Math.max(...values) - Math.min(...values))
          .withContext(prop)
          .toBeLessThanOrEqual(1);
      }
    } finally {
      cancelAnimationFrame(frame);
    }
  });

  it("selects on middle click without entering autoscroll or confirming", async () => {
    const items = suggestions(2);
    items[1].description = "Middle-click selection.";
    show(items);
    await frames();
    const row = view.ol.childNodes[1];
    const target = row.querySelector(".word");
    const down = new MouseEvent("mousedown", {
      button: 1,
      bubbles: true,
      cancelable: true,
    });
    const up = new MouseEvent("mouseup", {
      button: 1,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(down);
    target.dispatchEvent(up);
    await frames();

    expect(down.defaultPrevented).toBe(true);
    expect(up.defaultPrevented).toBe(true);
    expect(view.selectedIndex).toBe(1);
    expect(row.classList.contains("selected")).toBe(true);
    expect(view.descriptionContent.textContent).toBe("Middle-click selection.");
    expect(list.isActive()).toBe(true);
    expect(editor.getText()).toBe("k");
  });

  it("also suppresses middle-button autoscroll on empty list space", async () => {
    show(suggestions(2));
    await frames();
    const down = new MouseEvent("mousedown", {
      button: 1,
      bubbles: true,
      cancelable: true,
    });
    view.scroller.dispatchEvent(down);

    expect(down.defaultPrevented).toBe(true);
    expect(view.selectedIndex).toBe(0);
    expect(list.isActive()).toBe(true);
    expect(editor.getText()).toBe("k");
  });

  it("does not select or confirm a suggestion on right click", async () => {
    show(suggestions(2));
    await frames();
    const target = view.ol.childNodes[1].querySelector(".word");
    for (const type of ["mousedown", "mouseup"]) {
      target.dispatchEvent(new MouseEvent(type, { button: 2, bubbles: true, cancelable: true }));
    }
    await frames();

    expect(view.selectedIndex).toBe(0);
    expect(list.isActive()).toBe(true);
    expect(editor.getText()).toBe("k");
  });
});
