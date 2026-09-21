describe("autocomplete service lifecycle", () => {
  let mainModule;

  beforeEach(async () => {
    const pack = await lumine.packages.activatePackage("autocomplete");
    mainModule = pack.mainModule;
  });

  it("forgets the snippets service when its edge disappears", () => {
    const snippets = { insertSnippet() {} };
    const disposable = mainModule.consumeSnippets(snippets);

    expect(mainModule.autocompleteManager.snippetsManager).toBe(snippets);
    disposable.dispose();
    expect(mainModule.autocompleteManager.snippetsManager).toBeNull();
  });
});
