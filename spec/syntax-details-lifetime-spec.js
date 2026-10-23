require("./spec-helper");

describe("Autocomplete detail result ownership", () => {
  let editor, manager, release, epoch;
  beforeEach(async () => {
    jasmine.useRealClock();
    lumine.config.set("autocomplete.enableAutoActivation", false);
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    await lumine.packages.activatePackage("language-javascript");
    editor = await lumine.workspace.open();
    editor.setText("c");
    lumine.grammars.assignLanguageMode(editor.getBuffer(), "source.js");
    await editor.whenGrammarSettled();
    const mode = editor.getBuffer().getLanguageMode();
    epoch = 1;
    spyOn(
      mode,
      mode.getSyntaxRequestEpoch ? "getSyntaxRequestEpoch" : "getSyntaxGeneration",
    ).and.callFake(() => epoch);
    manager = (await lumine.packages.activatePackage("autocomplete")).mainModule
      .autocompleteManager;
    await manager.prepareCompletion();
    lumine.views.getView(editor).focus();
    manager.cancelSuggestions();
  });
  afterEach(() => {
    release?.();
    manager.cancelSuggestions();
    editor.destroy();
    release = null;
  });

  for (const change of ["query epoch", "new request"]) {
    it(`does not replace a reused suggestion object with details from before a ${change}`, async () => {
      const suggestion = {
        text: "console",
        provider: {
          getSuggestionDetailsOnSelect: () => new Promise((resolve) => (release = resolve)),
        },
      };
      manager.suggestionList.changeItems([suggestion]);
      const pending = manager.getDetailsOnSelect(suggestion);
      if (change === "query epoch") epoch++;
      else {
        manager.cancelSuggestions();
        manager.suggestionList.changeItems([suggestion]);
      }
      release({ text: "obsolete", description: "Old documentation" });
      await pending;
      expect(manager.suggestionList.items[0]).toBe(suggestion);
    });
  }

  it("treats a synchronous detail-provider exception like a rejected detail promise", async () => {
    const suggestion = {
      text: "console",
      provider: {
        getSuggestionDetailsOnSelect: () => {
          throw new Error("Detail unavailable");
        },
      },
    };
    let pending;
    expect(() => {
      pending = manager.getDetailsOnSelect(suggestion);
    }).not.toThrow();
    if (pending) expect(await pending).toBe(suggestion);
  });
});
