require("./spec-helper");

describe("Dynamically enabled autocomplete providers", () => {
  let manager, providerManager, editor, provider, registration, fallback;

  beforeEach(async () => {
    lumine.config.set("autocomplete.enableBuiltinProvider", true);
    lumine.config.set("autocomplete.enableAutoActivation", false);
    lumine.config.set("autocomplete.autoActivationDelay", 0);
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    editor = await lumine.workspace.open("");
    const pack = await lumine.packages.activatePackage("autocomplete");
    manager = pack.mainModule.autocompleteManager;
    providerManager = manager.providerManager;
    lumine.views.getView(editor).focus();
    editor.setText("a");
    editor.moveToEndOfLine();

    fallback = providerManager.defaultProvider;
    spyOn(fallback, "getSuggestions").and.returnValue([{ text: "alpha" }]);
    provider = {
      enabled: false,
      scopeSelector: "*",
      inclusionPriority: 10,
      suggestionPriority: 10,
      excludeLowerPriority: true,
      getSuggestions: jasmine.createSpy("getSuggestions").and.returnValue([{ text: "active" }]),
    };
    registration = pack.mainModule.consumeAutocomplete(provider);
  });

  afterEach(() => {
    manager.cancelSuggestions();
    registration.dispose();
  });

  const requestSuggestions = () => {
    manager.shouldDisplaySuggestions = true;
    return manager.findSuggestions(false);
  };

  it("does not query a disabled provider or let it exclude the built-in fallback", async () => {
    await requestSuggestions();

    expect(provider.getSuggestions).not.toHaveBeenCalled();
    expect(fallback.getSuggestions.calls.count()).toBe(1);
    expect(manager.suggestionList.items.map((item) => item.text)).toEqual(["alpha"]);
  });

  it("re-reads an enabled getter and resumes without another registration", async () => {
    let enabled = false;
    Object.defineProperty(provider, "enabled", { get: () => enabled });
    const metadata = providerManager.metadataForProvider(provider);
    await requestSuggestions();
    expect(provider.getSuggestions).not.toHaveBeenCalled();

    enabled = true;
    await requestSuggestions();
    expect(provider.getSuggestions.calls.count()).toBe(1);
    expect(manager.suggestionList.items.map((item) => item.text)).toEqual(["active"]);
    expect(fallback.getSuggestions.calls.count()).toBe(1);
    expect(providerManager.metadataForProvider(provider)).toBe(metadata);

    enabled = false;
    await requestSuggestions();
    expect(provider.getSuggestions.calls.count()).toBe(1);
    expect(fallback.getSuggestions.calls.count()).toBe(2);
    expect(manager.suggestionList.items.map((item) => item.text)).toEqual(["alpha"]);
  });

  it("keeps the previous behavior for every enabled value except explicit false", () => {
    for (const enabled of [undefined, null, 0, "", true]) {
      provider.enabled = enabled;
      expect(providerManager.applicableProviders(["workspace-center"], ".text.plain")).toEqual([
        provider,
      ]);
    }
    delete provider.enabled;
    expect(providerManager.applicableProviders(["workspace-center"], ".text.plain")).toEqual([
      provider,
    ]);
  });

  it("declines before consulting scope selectors or ranking fields", () => {
    const metadata = providerManager.metadataForProvider(provider);
    for (const property of ["scopeSelectors", "disableForScopeSelectors"]) {
      Object.defineProperty(metadata, property, {
        get() {
          throw new Error(`Disabled provider consulted ${property}`);
        },
      });
    }
    for (const property of ["suggestionPriority", "inclusionPriority", "excludeLowerPriority"]) {
      Object.defineProperty(provider, property, {
        get() {
          throw new Error(`Disabled provider consulted ${property}`);
        },
      });
    }

    expect(providerManager.applicableProviders(["workspace-center"], ".text.plain")).toEqual([
      fallback,
    ]);
  });

  it("does not activate on a disabled provider's trigger characters", () => {
    provider.triggerCharacters = new Set(["."]);
    editor.insertText(".");
    expect(provider.getSuggestions).not.toHaveBeenCalled();
    expect(fallback.getSuggestions).not.toHaveBeenCalled();

    provider.enabled = true;
    editor.insertText(".");
    expect(provider.getSuggestions.calls.count()).toBe(1);
  });
});
