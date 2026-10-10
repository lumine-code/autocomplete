describe("Autocomplete literal extra word characters", () => {
  let editor, lease, prefixes;

  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    lumine.config.set("autocomplete.enableBuiltinProvider", false);
    lumine.config.set("autocomplete.enableAutoActivation", false);
    lumine.config.set("autocomplete.enableAutoConfirmSingleSuggestion", false);
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("autocomplete");
    editor = await lumine.workspace.open();
    editor.getElement().focus();
    prefixes = [];
    lease = lumine.packages.serviceHub.provide("autocomplete.provider", "1.0.0", {
      scopeSelector: "*",
      getSuggestions({ prefix }) {
        prefixes.push(prefix);
        return [{ text: "owned-completion" }];
      },
    });
  });

  afterEach(async () => {
    lease?.dispose();
    editor?.destroy();
    if (lumine.packages.isPackageActive("autocomplete"))
      await lumine.packages.deactivatePackage("autocomplete");
    if (lumine.packages.isPackageLoaded("autocomplete"))
      await lumine.packages.unloadPackage("autocomplete");
    await lumine.fileWatchClient.settlePendingTeardown();
    editor = lease = prefixes = null;
  });

  async function request(text, characters) {
    lumine.config.set("autocomplete.extraWordCharacters", characters);
    editor.setText(text);
    editor.setCursorBufferPosition(editor.getBuffer().getEndPosition());
    lumine.commands.dispatch(editor.getElement(), "autocomplete:activate");
    await waitForFrames(() => prefixes.length === 1);
    return prefixes[0];
  }

  it("keeps a configured literal backslash and the terminal digit in the provider prefix", async () => {
    expect(await request("folder\\file2", "\\")).toBe("folder\\file2");
  });

  it("keeps the ordinary word boundary when no backslash is configured", async () => {
    expect(await request("folder\\file2", "")).toBe("file2");
  });

  it("keeps an ordinary configured punctuation character in the provider prefix", async () => {
    expect(await request("folder.file2", ".")).toBe("folder.file2");
  });
});
