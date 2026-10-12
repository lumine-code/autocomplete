describe("autocomplete presentation window", () => {
  let main;
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("autocomplete")).mainModule;
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("autocomplete");
    await lumine.workspace.discardEditorWindows();
  });
  it("renders and schedules rows in the local document and cancels them on transfer", async () => {
    const workspace = lumine.workspace;
    const extra = await workspace.openEditorWindow({ show: true });
    const editor = workspace.buildTextEditor();
    extra.getEditorContainer().getActivePane().activateItem(editor, { activatePane: true });
    editor.setText("a");
    editor.setCursorBufferPosition([0, 1]);
    const manager = main.autocompleteManager;
    manager.updateCurrentEditor(editor, []);
    const list = manager.suggestionList;
    list.changeItems(Array.from({ length: 180 }, (_, index) => ({ text: `answer${index}` })));
    const frame = spyOn(extra.getDocument().defaultView, "requestAnimationFrame").and.callThrough();
    list.showAtCursorPosition(editor);
    const view = list.suggestionListElement;
    expect(view.element.ownerDocument).toBe(extra.getDocument());
    expect(view.domWindow).toBe(extra.getDocument().defaultView);
    await conditionPromise(() => view.ol.children.length > 0);
    view.scroller.scrollTop = view.ol.firstChild.offsetHeight;
    await conditionPromise(() => view.ol.children.length === 180);
    expect(frame).toHaveBeenCalled();
    for (const row of view.ol.children) expect(row.ownerDocument).toBe(extra.getDocument());
    const cancel = spyOn(manager, "cancelSuggestions").and.callThrough();
    await workspace.attachWindow(extra);
    expect(cancel).toHaveBeenCalled();
    expect(list.activeEditor).toBeNull();
    list.showAtCursorPosition(editor);
    expect(view.element.ownerDocument).toBe(workspace.getMainWindow().getDocument());
  });
});
