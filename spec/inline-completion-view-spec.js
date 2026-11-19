const InlineCompletionView = require("../lib/inline-completion-view");

describe("Inline completion ghost text", () => {
  let editor, element, view;
  beforeEach(async () => {
    const pack = await lumine.packages.activatePackage("autocomplete");
    await pack.resourceLoadPromise;
    editor = lumine.workspace.buildTextEditor({ autoHeight: false, softWrapped: false });
    element = editor.getElement();
    element.style.width = "600px";
    element.style.height = "140px";
    jasmine.attachToDOM(element);
    element.setUpdatedSynchronously(true);
    view = new InlineCompletionView(editor);
  });

  afterEach(() => {
    view.destroy();
    editor.destroy();
    element.remove();
  });

  function rendered(selector, pseudo) {
    element.component.updateSync();
    const node = element.querySelector(selector);
    expect(node).not.toBeNull();
    return node && (pseudo ? window.getComputedStyle(node, pseudo) : node);
  }

  it("renders at an empty line and at end of line without editing the buffer", () => {
    const start = element.pixelPositionForBufferPosition([0, 0]);
    expect(view.show({ position: [0, 0], text: 'say("hello")' })).toBeTrue();
    const empty = rendered(".autocomplete-inline-ghost-empty", "::before");
    expect(empty.content).toContain('say(\\"hello\\")');
    expect(empty.pointerEvents).toBe("none");
    expect(element.pixelPositionForBufferPosition([0, 0])).toEqual(start);
    expect(editor.getText()).toBe("");
    editor.setText("say");
    expect(view.isShowing()).toBeFalse();
    const end = element.pixelPositionForBufferPosition([0, 3]);
    expect(view.show({ position: [0, 3], text: "(hello)" })).toBeTrue();
    expect(rendered(".autocomplete-inline-ghost-end", "::after").content).toContain("(hello)");
    expect(element.pixelPositionForBufferPosition([0, 3])).toEqual(end);
    expect(editor.getText()).toBe("say");
  });

  it("adds a bounded multiline block and keeps subsequent source text readable", () => {
    editor.setText("first\nreal next line");
    element.component.updateSync();
    const nextBefore = element.pixelPositionForBufferPosition([1, 0]).top;
    const group = [" first ghost", "  <literal>", ...Array.from({ length: 14 }, () => "more")];
    expect(view.show({ position: [0, 5], text: group.join("\r\n") })).toBeTrue();
    const continuation = rendered(".autocomplete-inline-continuation");
    expect(continuation.textContent.split("\n").length).toBe(11);
    expect(continuation.textContent).toContain("  <literal>");
    expect(continuation.textContent.endsWith("…")).toBeTrue();
    expect(continuation.querySelector("literal")).toBeNull();
    expect(continuation.getAttribute("aria-hidden")).toBe("true");
    expect(window.getComputedStyle(continuation).pointerEvents).toBe("none");
    expect(element.pixelPositionForBufferPosition([1, 0]).top).toBeGreaterThan(nextBefore);
    expect(editor.getText()).toBe("first\nreal next line");
    view.clear();
    element.component.updateSync();
    expect(element.querySelector(".autocomplete-inline-continuation")).toBeNull();
    expect(element.pixelPositionForBufferPosition([1, 0]).top).toBe(nextBefore);
  });

  it("marks replaced source without hiding it, including a deletion-only preview", () => {
    editor.setText("keep remove keep");
    const replacementRange = [
      [0, 5],
      [0, 11],
    ];
    expect(view.show({ position: [0, 5], text: "new", replacementRange })).toBeTrue();
    const replacement = rendered(".autocomplete-inline-replacement");
    expect(replacement.textContent).toBe("remove");
    expect(window.getComputedStyle(replacement).textDecorationLine).toBe("line-through");
    expect(rendered(".autocomplete-inline-ghost-after", "::after").content).toContain("new");
    expect(view.show({ position: [0, 5], text: "", replacementRange })).toBeTrue();
    expect(rendered(".autocomplete-inline-replacement").textContent).toBe("remove");
    expect(element.querySelector(".autocomplete-inline-ghost-after")).toBeNull();
    expect(editor.getText()).toBe("keep remove keep");
  });

  it("withdraws a folded or detached anchor and releases its decorations", () => {
    editor.setText("first\nsecond\nthird");
    expect(view.show({ position: [1, 6], text: " ghost\nextra row" })).toBeTrue();
    editor.foldBufferRowRange(0, 1);
    element.component.updateSync();
    expect(view.isShowing()).toBeFalse();
    expect(view.show({ position: [1, 6], text: " hidden ghost" })).toBeFalse();
    editor.unfoldAll();
    element.component.updateSync();
    expect(view.show({ position: [0, 0], text: "ghost" })).toBeTrue();
    expect(rendered(".autocomplete-inline-ghost-before", "::before").content).toContain("ghost");
    element.remove();
    expect(view.isShowing()).toBeFalse();
    expect(
      editor
        .getDecorations()
        .some((decoration) => decoration.getProperties().class?.startsWith("autocomplete-inline-")),
    ).toBeFalse();
  });
});
