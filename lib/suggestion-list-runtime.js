const { CompositeDisposable } = require("lumine");
const OVERLAY_SIDE = "below";
const OVERLAY_PRIORITY = 2;
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

    const completionKey = lumine.config.get("autocomplete.confirmCompletion") || "";

    const keys = {};
    if (completionKey.indexOf("tab") > -1) {
      keys["tab"] = "autocomplete:confirm";
    }
    if (completionKey.indexOf("enter") > -1) {
      if (completionKey.indexOf("always") > -1) {
        keys["enter"] = "autocomplete:confirm-if-non-default";
      } else {
        keys["enter"] = "autocomplete:confirm";
      }
    }

    this.bindings.add(
      lumine.keymaps.add("lumine-text-editor.autocomplete-active", {
        "lumine-text-editor.autocomplete-active:not([readonly])": keys,
      }),
    );

    const useCoreMovementCommands = lumine.config.get("autocomplete.useCoreMovementCommands");
    const commandNamespace = useCoreMovementCommands ? "core" : "autocomplete";

    const commands = {};
    commands[`${commandNamespace}:move-up`] = (event) => {
      if (this.isActive() && this.items && this.items.length > 1) {
        this.selectPrevious();
        return event.stopImmediatePropagation();
      }
    };
    commands[`${commandNamespace}:move-down`] = (event) => {
      if (this.isActive() && this.items && this.items.length > 1) {
        this.selectNext();
        return event.stopImmediatePropagation();
      }
    };
    commands[`${commandNamespace}:page-up`] = (event) => {
      if (this.isActive() && this.items && this.items.length > 1) {
        this.selectPageUp();
        return event.stopImmediatePropagation();
      }
    };
    commands[`${commandNamespace}:page-down`] = (event) => {
      if (this.isActive() && this.items && this.items.length > 1) {
        this.selectPageDown();
        return event.stopImmediatePropagation();
      }
    };
    commands[`${commandNamespace}:move-to-top`] = (event) => {
      if (this.isActive() && this.items && this.items.length > 1) {
        this.selectTop();
        return event.stopImmediatePropagation();
      }
    };
    commands[`${commandNamespace}:move-to-bottom`] = (event) => {
      if (this.isActive() && this.items && this.items.length > 1) {
        this.selectBottom();
        return event.stopImmediatePropagation();
      }
    };

    this.bindings.add(lumine.commands.add(lumine.views.getView(editor), commands));

    return this.bindings.add(
      lumine.config.onDidChange("autocomplete.useCoreMovementCommands", () => {
        return this.addBindings(editor);
      }),
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
    let bufferPosition;
    if (editor) {
      bufferPosition = editor.getCursorBufferPosition();
      if (followRawPrefix || this.wordPrefixRegex.test(prefix)) {
        bufferPosition = bufferPosition.translate([0, -prefix.length]);
      }
    }

    if (this.activeEditor === editor) {
      if (!bufferPosition.isEqual(this.displayBufferPosition)) {
        this.displayBufferPosition = bufferPosition;
        if (this.suggestionMarker) {
          this.suggestionMarker.setBufferRange([bufferPosition, bufferPosition]);
        }
      }
      this.updateCaretOffset(editor);
    } else {
      this.destroyOverlay();
      if (editor) {
        this.activeEditor = editor;
        this.displayBufferPosition = bufferPosition;
        const marker = (this.suggestionMarker = editor.markBufferRange([
          bufferPosition,
          bufferPosition,
        ]));
        this.suggestionListElement.bindDocument(editor.getElement().ownerDocument);
        this.overlayDecoration = editor.decorateMarker(marker, {
          type: "overlay",
          item: this.suggestionListElement,
          position: "tail",
          class: "autocomplete",
          side: OVERLAY_SIDE,
          priority: OVERLAY_PRIORITY,
        });
        const editorElement = lumine.views.getView(this.activeEditor);
        if (editorElement && editorElement.classList) {
          this.lastActiveAt = performance.now();
          editorElement.classList.add("autocomplete-active");
        }

        this.updateCaretOffset(editor);
        this.addBindings(editor);
      }
    }
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
    if (this.activeEditor === editor || editor == null) {
      return;
    }
    this.destroyOverlay();

    let marker;
    if (editor.getLastCursor()) {
      marker = editor.getLastCursor().getMarker();
    }
    if (marker) {
      this.activeEditor = editor;
      const editorElement = lumine.views.getView(this.activeEditor);
      if (editorElement && editorElement.classList) {
        this.lastActiveAt = performance.now();
        editorElement.classList.add("autocomplete-active");
      }

      this.suggestionListElement.bindDocument(editor.getElement().ownerDocument);
      this.overlayDecoration = editor.decorateMarker(marker, {
        type: "overlay",
        item: this.suggestionListElement,
        class: "autocomplete",
        side: OVERLAY_SIDE,
        priority: OVERLAY_PRIORITY,
      });
      return this.addBindings(editor);
    }
  }
  setOverlaySide(side) {
    if (this.overlayDecoration) {
      this.overlayDecoration.setProperties({ ...this.overlayDecoration.getProperties(), side });
    }
  }
  refitOverlay() {
    // A new column can change the alignment margin without resizing the box,
    // so the overlay's ResizeObserver alone cannot refit it to the window.
    const decoration = this.overlayDecoration;
    if (decoration) decoration.setProperties(decoration.getProperties());
  }
}
module.exports = Runtime.prototype;
