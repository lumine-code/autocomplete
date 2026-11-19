const { typeText } = require("./editor-input");
const path = require("path");
const { conditionPromise, timeoutPromise, waitForAutocomplete } = require("./spec-helper");

describe("Autocomplete Manager commit characters", () => {
  let editor, editorView, mainModule, provider;

  const registerProvider = (suggestions) => {
    provider = {
      scopeSelector: "*",
      inclusionPriority: 2,
      excludeLowerPriority: true,
      calls: 0,
      getSuggestions() {
        this.calls++;
        // A fresh copy each time: autocomplete annotates the suggestions it is
        // handed, and a shared object would carry that annotation over.
        return suggestions.map((suggestion) => Object.assign({}, suggestion));
      },
    };
    mainModule.consumeAutocomplete(provider);
  };

  beforeEach(async () => {
    const textGrammarPackage = await lumine.packages.activatePackage("language-text");
    await textGrammarPackage.resourceLoadPromise;
    lumine.workspace.project.setPaths([path.join(__dirname, "fixtures")]);
    jasmine.useRealClock();
    lumine.config.set("autocomplete.enableAutoActivation", true);
    lumine.config.set("autocomplete.autoActivationDelay", 0);
    lumine.config.set("autocomplete.commitCharacters", true);
    lumine.config.set("editor.fontSize", "16");
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));

    editor = await lumine.workspace.open("");
    editorView = lumine.views.getView(editor);
    mainModule = (await lumine.packages.activatePackage("autocomplete")).mainModule;
    await conditionPromise(
      () => mainModule.autocompleteManager && mainModule.autocompleteManager.ready,
    );
  });

  it("accepts the highlighted suggestion and then inserts the character", async () => {
    registerProvider([
      { text: "console", commitCharacters: ["(", "."] },
      { text: "constructor", commitCharacters: ["(", "."] },
    ]);

    typeText(editor, "c");
    await waitForAutocomplete(editor);

    typeText(editor, "(");
    await conditionPromise(() => editor.getText() === "console(");

    expect(editor.getCursorBufferPosition()).toEqual([0, 8]);
  });

  it("only commits a character delivered as editor input", async () => {
    registerProvider([{ text: "console", commitCharacters: ["("] }]);
    typeText(editor, "c");
    await waitForAutocomplete(editor);

    editor.insertText("(");
    expect(editor.getText()).toBe("c(");
    expect(mainModule.autocompleteManager.suggestionList.isActive()).toBeFalse();
    expect(provider.calls).toBe(1);
  });

  it("starts a new request when the commit character is also a trigger", async () => {
    registerProvider([{ text: "console", commitCharacters: ["."] }]);
    provider.triggerCharacters = new Set(["."]);
    const original = provider.getSuggestions.bind(provider);
    const suggestions = spyOn(provider, "getSuggestions").and.callFake((options) =>
      options.triggerCharacter === "." ? [{ text: "log" }] : original(),
    );
    typeText(editor, "c");
    await waitForAutocomplete(editor);

    typeText(editor, ".");
    await conditionPromise(() => suggestions.calls.count() === 2);
    expect(editor.getText()).toBe("console.");
    expect(suggestions.calls.mostRecent().args[0].triggerCharacter).toBe(".");
    await waitForAutocomplete(editor);
    expect(mainModule.autocompleteManager.suggestionList.items[0].text).toBe("log");
  });

  it("accepts whichever suggestion is highlighted, not the first one", async () => {
    registerProvider([
      { text: "console", commitCharacters: ["("] },
      { text: "constructor", commitCharacters: ["("] },
    ]);

    typeText(editor, "c");
    await waitForAutocomplete(editor);
    lumine.commands.dispatch(editorView, "core:move-down");

    typeText(editor, "(");
    await conditionPromise(() => editor.getText() === "constructor(");
  });

  it("undoes the whole acceptance in one step", async () => {
    registerProvider([
      { text: "console", commitCharacters: ["("] },
      { text: "constructor", commitCharacters: ["("] },
    ]);

    typeText(editor, "c");
    await waitForAutocomplete(editor);

    typeText(editor, "(");
    await conditionPromise(() => editor.getText() === "console(");

    // One undo takes back the undo-confirm-retype the commit character made,
    // leaving exactly what the user had typed.
    editor.undo();
    expect(editor.getText()).toBe("c(");
  });

  it("does not read its own edits back as typing", async () => {
    // With the list open but no activation on keystroke, nothing else can ask
    // the provider for suggestions, so the call count is the whole story: the
    // deletion of the character alone would otherwise request a new list.
    lumine.config.set("autocomplete.enableAutoActivation", false);
    registerProvider([
      { text: "console", commitCharacters: ["("] },
      { text: "constructor", commitCharacters: ["("] },
    ]);

    typeText(editor, "c");
    lumine.commands.dispatch(editorView, "autocomplete:activate");
    await waitForAutocomplete(editor);
    expect(provider.calls).toBe(1);

    typeText(editor, "(");
    await conditionPromise(() => editor.getText() === "console(");

    expect(provider.calls).toBe(1);
    expect(editorView.querySelectorAll(".autocomplete li").length).toBe(0);
    expect(mainModule.autocompleteManager.applyingCompletionEdit).toBeFalsy();
  });

  it("stays out of the way when the setting is off", async () => {
    lumine.config.set("autocomplete.commitCharacters", false);
    registerProvider([
      { text: "console", commitCharacters: ["("] },
      { text: "constructor", commitCharacters: ["("] },
    ]);

    typeText(editor, "c");
    await waitForAutocomplete(editor);

    typeText(editor, "(");
    await timeoutPromise(200);
    expect(editor.getText()).toBe("c(");
  });

  it("stays out of the way for a character the suggestion does not list", async () => {
    registerProvider([
      { text: "console", commitCharacters: ["."] },
      { text: "constructor", commitCharacters: ["."] },
    ]);

    typeText(editor, "c");
    await waitForAutocomplete(editor);

    typeText(editor, "(");
    await timeoutPromise(200);
    expect(editor.getText()).toBe("c(");
  });

  it("stays out of the way for a suggestion with no commit characters", async () => {
    registerProvider([{ text: "console" }, { text: "constructor" }]);

    typeText(editor, "c");
    await waitForAutocomplete(editor);

    typeText(editor, "(");
    await timeoutPromise(200);
    expect(editor.getText()).toBe("c(");
  });

  it("stays out of the way when no list is showing", async () => {
    lumine.config.set("autocomplete.enableAutoActivation", false);
    registerProvider([{ text: "console", commitCharacters: ["("] }]);

    typeText(editor, "c");
    typeText(editor, "(");
    await timeoutPromise(200);
    expect(editor.getText()).toBe("c(");
    expect(provider.calls).toBe(0);
    // Nothing is asked of the menu either: reaching for the highlighted item
    // of a list that is not showing would build the whole thing to find out
    // that it holds nothing.
    expect(mainModule.autocompleteManager.suggestionList._suggestionListElement).toBeUndefined();
  });
});
