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

  function suffixCoordinates() {
    for (const line of element.querySelectorAll(".line")) {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const offset = node.textContent.indexOf("Z");
        if (offset < 0) continue;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        const { left, top, width } = range.getBoundingClientRect();
        return { left, top, width };
      }
    }
    throw new Error("The editor did not render the suffix glyph.");
  }

  function renderedGeometry() {
    element.component.updateSync();
    const position = (selector) => {
      const { left, top } = element.querySelector(selector).getBoundingClientRect();
      return { left, top };
    };
    return {
      cursor: position(".cursor"),
      input: position(".hidden-input"),
      suffix: suffixCoordinates(),
    };
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

  it("keeps the caret and native input at a midline preview while moving the suffix", () => {
    const source = "abcZtail";
    const anchor = [0, 3];
    editor.setText(source);
    editor.setCursorBufferPosition(anchor);
    element.focus();
    const before = renderedGeometry();
    expect(before.input).toEqual(before.cursor);
    expect(before.suffix.width).toBeGreaterThan(0);

    expect(view.show({ position: anchor, text: " a long inline preview " })).toBeTrue();
    const preview = renderedGeometry();
    expect(preview.suffix.left).toBeGreaterThan(before.suffix.left + 10);
    expect(preview.suffix.top).toBe(before.suffix.top);
    expect(preview.cursor).toEqual(before.cursor);
    expect(preview.input).toEqual(before.input);
    expect(editor.getCursorBufferPosition().toArray()).toEqual(anchor);
    expect(editor.getText()).toBe(source);

    view.clear();
    expect(renderedGeometry()).toEqual(before);
    expect(editor.getCursorBufferPosition().toArray()).toEqual(anchor);
  });

  it("keeps a later caret aligned with its real text when the preview anchor comes first", () => {
    const caret = [0, 5];
    editor.setText("abcZtail");
    editor.setCursorBufferPosition(caret);
    element.focus();
    const before = renderedGeometry();

    expect(view.show({ position: [0, 3], text: " a long inline preview " })).toBeTrue();
    const preview = renderedGeometry();
    const suffixShift = preview.suffix.left - before.suffix.left;
    const cursorShift = preview.cursor.left - before.cursor.left;
    expect(suffixShift).toBeGreaterThan(10);
    // The editor rounds caret coordinates, while DOM text ranges have fractional pixels.
    expect(Math.abs(cursorShift - suffixShift)).toBeLessThanOrEqual(1);
    expect(preview.cursor.top).toBe(before.cursor.top);
    expect(preview.input).toEqual(preview.cursor);
    expect(editor.getCursorBufferPosition().toArray()).toEqual(caret);
  });

  it("keeps the caret and native input before a ghost at the start of a wrapped row", () => {
    editor.update({ softWrapped: true, softWrapMaxColumn: 10 });
    editor.setText("abcdefghijZtail");
    const anchor = [0, 10];
    editor.setCursorBufferPosition(anchor);
    element.focus();
    const before = renderedGeometry();
    expect(editor.getCursorScreenPosition().toArray()).toEqual([1, 0]);
    expect(before.input).toEqual(before.cursor);

    expect(view.show({ position: anchor, text: " ghost " })).toBeTrue();
    const preview = renderedGeometry();
    expect(element.querySelector(".autocomplete-inline-ghost-before")).not.toBeNull();
    expect(preview.suffix.left).toBeGreaterThan(before.suffix.left + 10);
    expect(preview.suffix.top).toBe(before.suffix.top);
    expect(preview.cursor).toEqual(before.cursor);
    expect(preview.input).toEqual(before.input);
    expect(editor.getCursorBufferPosition().toArray()).toEqual(anchor);

    view.clear();
    expect(renderedGeometry()).toEqual(before);
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
