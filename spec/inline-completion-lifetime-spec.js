require("./spec-helper");

describe("Autocomplete with inline parser publication", () => {
  let editor, manager, mode, registration, release, registry, grammar, grammarRegistration;

  beforeEach(async () => {
    const textGrammarPackage = await lumine.packages.activatePackage("language-text");
    await textGrammarPackage.resourceLoadPromise;
    jasmine.useRealClock();
    lumine.config.set("autocomplete.enableAutoActivation", false);
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    await lumine.packages.activatePackage("language-javascript");
    editor = await lumine.workspace.open();
    editor.setText("fu");
    const sourceGrammar = lumine.grammars.grammarForScopeName("source.js");
    registry = new lumine.grammars.constructor({
      config: lumine.config,
      syntaxExecution: "inline",
    });
    grammar = new sourceGrammar.constructor(
      registry,
      sourceGrammar.grammarFilePath,
      sourceGrammar.definition,
    );
    grammarRegistration = registry.addGrammar(grammar);
    registry.assignLanguageMode(editor.getBuffer(), "source.js");
    await editor.whenGrammarSettled();
    mode = editor.getBuffer().getLanguageMode();
    expect(mode.constructor.name).toBe("TreeSitterLanguageMode");
    expect(mode.grammarRegistry).toBe(registry);
    const pack = await lumine.packages.activatePackage("autocomplete");
    manager = pack.mainModule.autocompleteManager;
    await manager.prepareCompletion();
    lumine.views.getView(editor).focus();
    editor.setCursorBufferPosition([0, 2]);
    manager.cancelSuggestions();
    registration = pack.mainModule.consumeAutocomplete({
      scopeSelector: "*",
      inclusionPriority: 10,
      excludeLowerPriority: true,
      getSuggestions: () => new Promise((resolve) => (release = resolve)),
    });
  });

  afterEach(() => {
    release?.([]);
    manager.cancelSuggestions();
    registration.dispose();
    editor.destroy();
    grammarRegistration.dispose();
    grammar.deactivate();
    registry.clear();
    release = null;
  });

  async function publish() {
    manager.shouldDisplaySuggestions = true;
    const pending = manager.getSuggestionsFromProviders({
      editor,
      bufferPosition: editor.getCursorBufferPosition(),
      scopeDescriptor: editor.getRootScopeDescriptor(),
      prefix: "fu",
      legacyPrefix: "fu",
    });
    release([{ text: "function" }]);
    await pending;
    return manager.suggestionList.items[0];
  }

  it("confirms the same suggestion after an ordinary inline reparse", async () => {
    const suggestion = await publish();
    const revision = editor.getBuffer().getTextRevision();
    mode.requestDocumentUpdate();
    await mode.atGrammarSettlement();
    expect(editor.getBuffer().getTextRevision()).toBe(revision);
    expect(manager.suggestionList.isActive()).toBe(true);
    await manager.confirm(suggestion);
    expect(editor.getText()).toBe("function");
  });

  for (const change of ["query", "root-range policy"]) {
    it(`rejects an existing suggestion after a real ${change} change`, async () => {
      const suggestion = await publish();
      const originalQuery = mode.grammar.highlightsQuery;
      try {
        if (change === "query") {
          await mode.grammar.setQueryForTest("highlightsQuery", "(identifier) @variable.test");
        } else {
          const policy = registry.setRootLanguageRanges(editor.getBuffer(), () => null);
          policy.dispose();
        }
        await manager.confirm(suggestion);
        expect(editor.getText()).toBe("fu");
      } finally {
        if (change === "query")
          await mode.grammar.setQueryForTest("highlightsQuery", originalQuery);
      }
    });
  }
});
