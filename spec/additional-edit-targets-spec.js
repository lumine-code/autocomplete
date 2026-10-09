describe("Additional completion edit targets", () => {
  let editor, main, manager, lease;

  beforeEach(async () => {
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.returnValue(Promise.resolve());
    spyOn(lumine.application, "openWindow").and.returnValue(Promise.resolve());
    lumine.config.set("autocomplete.enableBuiltinProvider", false);
    lumine.config.set("autocomplete.enableAutoActivation", false);
    lumine.config.set("autocomplete.enableAutoConfirmSingleSuggestion", false);
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("autocomplete")).mainModule;
    manager = main.autocompleteManager;
    editor = await lumine.workspace.open();
    editor.getElement().focus();
  });

  afterEach(() => {
    lease?.dispose();
    editor?.destroy();
    for (const setting of [
      "enableBuiltinProvider",
      "enableAutoActivation",
      "enableAutoConfirmSingleSuggestion",
    ])
      lumine.config.unset(`autocomplete.${setting}`);
    lease = editor = main = manager = null;
  });

  async function complete(suggestion) {
    lease = lumine.packages.serviceHub.provide("autocomplete.provider", "1.0.0", {
      scopeSelector: "*",
      getSuggestions: () => [suggestion],
    });
    lumine.commands.dispatch(editor.getElement(), "autocomplete:activate");
    await waitForFrames(() => manager.suggestionList.items?.length === 1);
    await manager.confirm(manager.suggestionList.items[0]);
  }

  it("applies an import once while replacing the main prefix at both cursors", async () => {
    editor.setText("a a");
    editor.setCursorBufferPosition([0, 1]);
    editor.addCursorAtBufferPosition([0, 3]);
    await complete({
      text: "alpha",
      textEdit: {
        range: [
          [0, 2],
          [0, 3],
        ],
        newText: "alpha",
      },
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
    expect(editor.getText()).toBe("imported\nalpha alpha");
    editor.undo();
    expect(editor.getText()).toBe("a a");
  });

  it("sorts mixed range and oldRange additional edits in original buffer coordinates", async () => {
    editor.setText("header\na");
    editor.setCursorBufferPosition([1, 1]);
    await complete({
      text: "alpha",
      textEdit: {
        oldRange: [
          [1, 0],
          [1, 1],
        ],
        newText: "alpha",
      },
      additionalTextEdits: [
        {
          range: [
            [0, 6],
            [0, 6],
          ],
          newText: ";",
        },
        {
          oldRange: [
            [0, 0],
            [0, 6],
          ],
          newText: "imported",
        },
      ],
    });
    expect(editor.getText()).toBe("imported;\nalpha");
    editor.undo();
    expect(editor.getText()).toBe("header\na");
  });

  it("preserves an adjacent insertion when another additional edit replaces its preceding text", async () => {
    editor.setText("header\na");
    editor.setCursorBufferPosition([1, 1]);
    await complete({
      text: "alpha",
      textEdit: {
        range: [
          [1, 0],
          [1, 1],
        ],
        newText: "alpha",
      },
      additionalTextEdits: [
        {
          range: [
            [0, 6],
            [0, 6],
          ],
          newText: ";",
        },
        {
          range: [
            [0, 0],
            [0, 6],
          ],
          newText: "imported",
        },
      ],
    });
    expect(editor.getText()).toBe("imported;\nalpha");
    editor.undo();
    expect(editor.getText()).toBe("header\na");
  });
});
