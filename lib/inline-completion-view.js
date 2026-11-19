const { CompositeDisposable, Point, Range } = require("lumine");

const PREVIEW_LINES = 12;
const PREVIEW_LENGTH = 4096;
const GHOST_TEXT = "--autocomplete-inline-ghost-text";
const GHOST_TAB_SIZE = "--autocomplete-inline-tab-size";

function previewLines(text) {
  if (text.length > PREVIEW_LENGTH)
    text = text.slice(0, PREVIEW_LENGTH - 1).replace(/[\uD800-\uDBFF]$/, "") + "…";
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > PREVIEW_LINES) {
    lines.length = PREVIEW_LINES;
    lines[PREVIEW_LINES - 1] = "…";
  }
  return lines;
}

// Provider text is a CSS string value, with its quotes and control characters
// escaped independently of the editor's syntax and theme.
function cssString(text) {
  return `"${text.replace(/["\\\p{Cc}]/gu, (character) =>
    character === '"' || character === "\\"
      ? `\\${character}`
      : `\\${character.charCodeAt(0).toString(16)} `,
  )}"`;
}

module.exports = class InlineCompletionView {
  constructor(editor) {
    this.editor = editor;
    this.element = editor.getElement();
    this.subscriptions = new CompositeDisposable(editor.onDidDestroy(() => this.destroy()));
    const detached = this.element.onDidDetach?.(() => this.clear());
    if (detached) this.subscriptions.add(detached);
    this.presentation = null;
  }

  isShowing() {
    return this.presentation !== null;
  }

  show({ position, text, replacementRange }) {
    this.clear();
    const { editor, element } = this;
    if (!editor || !element.isConnected || typeof text !== "string" || !position) return false;
    const anchor = Point.fromObject(position, true);
    if (
      !editor.clipBufferPosition(anchor).isEqual(anchor) ||
      editor.isFoldedAtBufferRow(anchor.row)
    )
      return false;
    const replacement = replacementRange && Range.fromObject(replacementRange, true);
    if (!text && (!replacement || replacement.isEmpty())) return false;
    if (replacement && !editor.clipBufferRange(replacement).isEqual(replacement)) return false;

    const buffer = editor.getBuffer();
    const revision = buffer.getTextRevision();
    const screenAnchor = editor.screenPositionForBufferPosition(anchor);
    const [first, ...rest] = previewLines(text);
    const presentation = { markers: [], change: null };
    this.presentation = presentation;
    try {
      this.batch(() => {
        if (first) this.decorateFirstLine(anchor, screenAnchor, first);
        if (rest.length) this.decorateContinuation(anchor, rest);
        if (replacement && !replacement.isEmpty()) {
          this.decorate(editor.markBufferRange(replacement, { invalidate: "touch" }), {
            type: "text",
            class: "autocomplete-inline-replacement",
          });
        }
      });
      presentation.change = editor.onDidChange((changes) => {
        if (Array.isArray(changes) && changes.every(({ origin }) => origin === "highlight")) return;
        if (
          buffer.getTextRevision() !== revision ||
          editor.isFoldedAtBufferRow(anchor.row) ||
          !editor.screenPositionForBufferPosition(anchor).isEqual(screenAnchor)
        )
          this.clear();
      });
      return true;
    } catch (error) {
      this.clear();
      throw error;
    }
  }

  decorateFirstLine(anchor, screenAnchor, text) {
    const { editor, element } = this;
    const { row, column } = anchor;
    const length = editor.getBuffer().lineLengthForRow(row);
    const value = cssString(text);
    if (column === length) {
      // Keep EOL ghosts on the row itself. Empty rows have no real text span,
      // and nonempty rows can already have text decorations on the last glyph.
      element.style.setProperty(GHOST_TEXT, value);
      element.style.setProperty(GHOST_TAB_SIZE, editor.getTabLength());
      this.decorate(editor.markBufferPosition(anchor, { invalidate: "touch" }), {
        type: "line",
        class: length === 0 ? "autocomplete-inline-ghost-empty" : "autocomplete-inline-ghost-end",
      });
      return;
    }
    const before = new Point(row, Math.max(0, column - 1));
    const afterPrevious =
      column > 0 && editor.screenPositionForBufferPosition(before).row === screenAnchor.row;
    let range;
    if (afterPrevious) {
      const tail = editor.getTextInBufferRange([[row, Math.max(0, column - 2)], anchor]);
      const width = /[\uD800-\uDBFF][\uDC00-\uDFFF]$/.test(tail) ? 2 : 1;
      range = new Range([row, column - width], anchor);
    } else {
      const head = editor.getTextInBufferRange([anchor, [row, Math.min(length, column + 2)]]);
      const width = head.codePointAt(0) > 0xffff ? 2 : 1;
      range = new Range(anchor, [row, column + width]);
    }
    this.decorate(editor.markBufferRange(range, { invalidate: "touch" }), {
      type: "text",
      class: afterPrevious ? "autocomplete-inline-ghost-after" : "autocomplete-inline-ghost-before",
      style: {
        [GHOST_TEXT]: value,
        [GHOST_TAB_SIZE]: editor.getTabLength(),
      },
    });
  }

  decorateContinuation(anchor, lines) {
    const { editor, element } = this;
    const continuation = element.ownerDocument.createElement("div");
    continuation.className = "autocomplete-inline-continuation";
    continuation.setAttribute("aria-hidden", "true");
    continuation.textContent = lines.join("\n");
    continuation.style.tabSize = editor.getTabLength();
    continuation.style.minBlockSize = `${lines.length}lh`;
    this.decorate(editor.markBufferPosition(anchor, { invalidate: "touch" }), {
      type: "block",
      position: "after",
      item: continuation,
    });
  }

  decorate(marker, properties) {
    this.presentation.markers.push(marker);
    this.editor.decorateMarker(marker, properties);
  }

  batch(callback) {
    if (this.editor.batchDecorations) this.editor.batchDecorations(callback);
    else callback();
  }

  clear() {
    const presentation = this.presentation;
    if (!presentation) return;
    this.presentation = null;
    presentation.change?.dispose();
    this.element.style.removeProperty(GHOST_TEXT);
    this.element.style.removeProperty(GHOST_TAB_SIZE);
    if (!this.editor.isDestroyed())
      this.batch(() => {
        for (const marker of presentation.markers) marker.destroy();
      });
  }

  destroy() {
    this.clear();
    this.subscriptions.dispose();
    this.editor = null;
    this.element = null;
  }
};
