const { CompositeDisposable } = require("lumine");
const OVERLAY_SIDE = "below";
const OVERLAY_PRIORITY = 2;
const CONFIRMATION_BINDINGS = {
  tab: { tab: "autocomplete:confirm" },
  enter: { enter: "autocomplete:confirm" },
  "tab and enter": { tab: "autocomplete:confirm", enter: "autocomplete:confirm" },
  "tab always, enter when suggestion explicitly selected": {
    tab: "autocomplete:confirm",
    enter: "autocomplete:confirm-if-non-default",
  },
};

const readMountedPopup = (model, editor, decoration, mounted) => {
  mounted.then(() => {
    const view = model._suggestionListElement;
    if (
      model.activeEditor !== editor ||
      model.overlayDecoration !== decoration ||
      decoration.isDestroyed() ||
      !view ||
      view.disposed
    )
      return;
    const generation = view.initialPresentationGeneration;
    lumine.views.readDocument(() => {
      if (
        model.activeEditor === editor &&
        model.overlayDecoration === decoration &&
        !decoration.isDestroyed() &&
        model._suggestionListElement === view &&
        !view.disposed &&
        generation === view.initialPresentationGeneration &&
        view.element.isConnected
      )
        view.readUIPropsFromDOM();
    });
  });
};

function mountOverlay(list, editor, marker, position) {
  const editorElement = lumine.views.getView(editor);
  list.activeEditor = editor;
  list.overlayEditorElement = editorElement;
  const view = list.suggestionListElement;
  view.bindDocument(editorElement.ownerDocument);
  view.prepareForOverlayMount();
  const mounted = editorElement.getNextUpdatePromise();
  const decoration = (list.overlayDecoration = editor.decorateMarker(marker, {
    type: "overlay",
    item: view,
    position,
    class: "autocomplete",
    side: OVERLAY_SIDE,
    priority: OVERLAY_PRIORITY,
  }));
  editorElement.classList.add("autocomplete-active");
  list.addBindings(editor);
  readMountedPopup(list, editor, decoration, mounted);
}

class Runtime {
  addBindings(editor) {
    if (this.bindings && this.bindings.dispose) {
      this.bindings.dispose();
    }
    this.bindings = new CompositeDisposable();

    // The pointer drawn on the popup follows the caret, and the caret can
    // move while the popup stays up — arrow keys with move-to-cancel off, a
    // click that repositions within the word. The show path republishes on
    // its own; this covers every move it never hears about.
    this.bindings.add(
      editor.onDidChangeCursorPosition(({ cursor }) => {
        if (cursor !== editor.getLastCursor()) return;
        if (this.activeEditor === editor) this.updateCaretOffset(editor);
      }),
    );

    const completionKey = lumine.config.get("autocomplete.confirmCompletion");
    this.bindings.add(
      lumine.keymaps.add("lumine-text-editor.autocomplete-active", {
        "lumine-text-editor.autocomplete-active:not([readonly])":
          CONFIRMATION_BINDINGS[completionKey] ?? {},
      }),
    );

    const useCoreMovementCommands = lumine.config.get("autocomplete.useCoreMovementCommands");
    const commandNamespace = useCoreMovementCommands ? "core" : "autocomplete";

    const commands = {};
    for (const [command, select] of [
      ["move-up", this.selectPrevious],
      ["move-down", this.selectNext],
      ["page-up", this.selectPageUp],
      ["page-down", this.selectPageDown],
      ["move-to-top", this.selectTop],
      ["move-to-bottom", this.selectBottom],
    ]) {
      commands[`${commandNamespace}:${command}`] = (event) => {
        if (this.activeEditor !== editor || this.displayedItems.length <= 1) return;
        select.call(this);
        return event.stopImmediatePropagation();
      };
    }

    this.bindings.add(lumine.commands.add(lumine.views.getView(editor), commands));

    return this.bindings.add(
      lumine.config.onDidChange("autocomplete.useCoreMovementCommands", () => {
        return this.addBindings(editor);
      }),
      lumine.config.onDidChange("autocomplete.confirmCompletion", () => this.addBindings(editor)),
    );
  }
  show(editor, options) {
    if (lumine.config.get("autocomplete.suggestionListFollows") === "Cursor") {
      return this.showAtCursorPosition(editor, options);
    } else {
      let { prefix } = options;
      let followRawPrefix = false;
      for (let i = 0; i < this.items.length; i++) {
        const item = this.items[i];
        if (item.replacementPrefix != null) {
          prefix = item.replacementPrefix.trim();
          followRawPrefix = true;
          break;
        }
      }
      return this.showAtBeginningOfPrefix(editor, prefix, followRawPrefix);
    }
  }
  showAtBeginningOfPrefix(editor, prefix, followRawPrefix = false) {
    if (!editor) return;
    let bufferPosition = editor.getCursorBufferPosition();
    if (followRawPrefix || this.wordPrefixRegex.test(prefix)) {
      bufferPosition = bufferPosition.translate([0, -prefix.length]);
    }

    if (this.activeEditor === editor && this.suggestionMarker) {
      if (!bufferPosition.isEqual(this.displayBufferPosition)) {
        this.displayBufferPosition = bufferPosition;
        this.suggestionMarker.setBufferRange([bufferPosition, bufferPosition]);
      }
      this.updateCaretOffset(editor);
      return;
    }

    this.destroyOverlay();
    this.displayBufferPosition = bufferPosition;
    this.suggestionMarker = editor.markBufferRange([bufferPosition, bufferPosition]);
    mountOverlay(this, editor, this.suggestionMarker, "tail");
    this.updateCaretOffset(editor);
  }
  updateCaretOffset(editor) {
    const editorElement = editor && lumine.views.getView(editor);
    const component = editorElement && editorElement.getComponent?.();
    if (!component || !this.displayBufferPosition) return;
    const publish = () => {
      if (this.activeEditor !== editor || !this.displayBufferPosition) return;
      const anchor = component.pixelPositionForScreenPosition(
        editor.screenPositionForBufferPosition(this.displayBufferPosition),
      );
      const caret = component.pixelPositionForScreenPosition(editor.getCursorScreenPosition());
      const offset = Math.max(0, Math.round(caret.left - anchor.left));
      editorElement.style.setProperty("--autocomplete-caret-offset", `${offset}px`);
    };
    // Read after the editor and popup have written their pending DOM. An
    // immediate cache miss here forces an entire editor update inside show(),
    // then the queued popup measurement performs another layout.
    lumine.views.readDocument(publish);
  }
  showAtCursorPosition(editor) {
    if (!editor || (this.activeEditor === editor && !this.suggestionMarker)) return;
    this.destroyOverlay();
    const marker = editor.getLastCursor()?.getMarker();
    if (marker) mountOverlay(this, editor, marker);
  }
  setOverlaySide(side) {
    const decoration = this.overlayDecoration;
    const editorElement = lumine.views.getView(this.activeEditor);
    if (decoration && !decoration.isDestroyed() && editorElement) {
      const updated = editorElement.getNextUpdatePromise();
      decoration.setProperties({ ...decoration.getProperties(), side });
      return updated;
    }
  }
  refitOverlay() {
    // A new column can change the alignment margin without resizing the box,
    // so the overlay's ResizeObserver alone cannot refit it to the window.
    const decoration = this.overlayDecoration;
    const editorElement = lumine.views.getView(this.activeEditor);
    if (decoration && !decoration.isDestroyed() && editorElement) {
      const updated = editorElement.getNextUpdatePromise();
      decoration.setProperties(decoration.getProperties());
      return updated;
    }
  }
}
module.exports = Runtime.prototype;
