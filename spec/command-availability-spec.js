describe("Autocomplete command availability", () => {
  let main, manager, editor, other;
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("autocomplete")).mainModule;
    manager = main.autocompleteManager;
    editor = await lumine.workspace.open();
    editor.element.focus();
  });
  afterEach(async () => {
    other?.destroy();
    editor.destroy();
    await lumine.packages.deactivatePackage("autocomplete");
    other = null;
  });
  it("does not offer completion for an unobserved fragment", () => {
    other = lumine.workspace.buildTextEditor();
    lumine.workspace.getElement().appendChild(other.element);
    expect(lumine.commands.canDispatch(other.element, "autocomplete:activate")).toBe(false);
    expect(manager.editor).toBe(editor);
  });
  it("activates the watched dispatch editor even after focus moved elsewhere", async () => {
    other = await lumine.workspace.open();
    other.element.focus();
    spyOn(manager, "findSuggestions");
    await lumine.commands.dispatch(editor.element, "autocomplete:activate");
    expect(manager.editor).toBe(editor);
    expect(manager.findSuggestions).toHaveBeenCalled();
  });
  it("declines readonly activation and insertion, including a late direct insertion", () => {
    editor.setText("original");
    editor.setReadOnly(true);
    editor.element.classList.add("autocomplete-active");
    for (const name of [
      "autocomplete:activate",
      "autocomplete:confirm",
      "autocomplete:confirm-if-non-default",
    ])
      expect(lumine.commands.canDispatch(editor.element, name)).toBe(false);
    expect(
      lumine.keymaps.findKeyBindings({ target: editor.element, command: "autocomplete:activate" }),
    ).toEqual([]);
    expect(() =>
      manager.insertSuggestion({ text: "replacement" }, editor.getCursorBufferPosition()),
    ).not.toThrow();
    expect(editor.getText()).toBe("original");
    expect(lumine.commands.canDispatch(editor.element, "autocomplete:cancel")).toBe(true);
  });
});
