const { Emitter, CompositeDisposable } = require("lumine");
const { UnicodeLetters } = require("./unicode-helpers");
const SuggestionListElement = require("./suggestion-list-element");

// The popup hangs below the word being completed, and it outranks every other
// overlay for that space: it is the surface the reader is driving, and its rows
// line up with the prefix. Anything else sharing the line takes the other side
// of it, or steps past it. See `side` and `priority` on `decorateMarker`.
const OVERLAY_SIDE = "below";
const OVERLAY_PRIORITY = 2;

module.exports = class SuggestionList {
  constructor() {
    this.wordPrefixRegex = null;
    this.cancel = this.cancel.bind(this);
    this.confirm = this.confirm.bind(this);
    this.confirmSelection = this.confirmSelection.bind(this);
    this.confirmSelectionIfNonDefault = this.confirmSelectionIfNonDefault.bind(this);
    this.show = this.show.bind(this);
    this.showAtBeginningOfPrefix = this.showAtBeginningOfPrefix.bind(this);
    this.showAtCursorPosition = this.showAtCursorPosition.bind(this);
    this.hide = this.hide.bind(this);
    this.destroyOverlay = this.destroyOverlay.bind(this);
    this.activeEditor = null;
    this.lastActiveAt = 0;
  }

  initialize() {
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();

    this.subscriptions.add(
      lumine.commands.add("lumine-text-editor.autocomplete-active", {
        "autocomplete:confirm": this.confirmSelection,
        "autocomplete:confirmIfNonDefault": this.confirmSelectionIfNonDefault,
        "autocomplete:cancel": this.cancel,
      }),
    );
    this.subscriptions.add(
      lumine.config.observe(
        "autocomplete.enableExtendedUnicodeSupport",
        (enableExtendedUnicodeSupport) => {
          if (enableExtendedUnicodeSupport) {
            this.wordPrefixRegex = new RegExp(`^[${UnicodeLetters}\\d_-]`);
          } else {
            this.wordPrefixRegex = /^[\w-]/;
          }
          return this.wordPrefixRegex;
        },
      ),
    );
  }

  get suggestionListElement() {
    if (!this._suggestionListElement) {
      this._suggestionListElement = new SuggestionListElement(this);
    }

    return this._suggestionListElement;
  }

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
      editor.onDidChangeCursorPosition(() => {
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
        keys["enter"] = "autocomplete:confirmIfNonDefault";
      } else {
        keys["enter"] = "autocomplete:confirm";
      }
    }

    this.bindings.add(
      lumine.keymaps.add("lumine-text-editor.autocomplete-active", {
        "lumine-text-editor.autocomplete-active": keys,
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

  /*
  Section: Event Triggers
  */

  cancel() {
    return this.emitter.emit("did-cancel");
  }

  confirm(match) {
    return this.emitter.emit("did-confirm", match);
  }

  confirmSelection() {
    return this.emitter.emit("did-confirm-selection");
  }

  confirmSelectionIfNonDefault(event) {
    return this.emitter.emit("did-confirm-selection-if-non-default", event);
  }

  select(suggestion) {
    return this.emitter.emit("did-select", suggestion);
  }

  selectNext() {
    return this.emitter.emit("did-select-next");
  }

  selectPrevious() {
    return this.emitter.emit("did-select-previous");
  }

  selectPageUp() {
    return this.emitter.emit("did-select-page-up");
  }

  selectPageDown() {
    return this.emitter.emit("did-select-page-down");
  }

  selectTop() {
    return this.emitter.emit("did-select-top");
  }

  selectBottom() {
    return this.emitter.emit("did-select-bottom");
  }

  /*
  Section: Events
  */

  onDidConfirmSelection(fn) {
    return this.emitter.on("did-confirm-selection", fn);
  }

  onDidconfirmSelectionIfNonDefault(fn) {
    return this.emitter.on("did-confirm-selection-if-non-default", fn);
  }

  onDidConfirm(fn) {
    return this.emitter.on("did-confirm", fn);
  }

  onDidSelect(fn) {
    return this.emitter.on("did-select", fn);
  }

  onDidSelectNext(fn) {
    return this.emitter.on("did-select-next", fn);
  }

  onDidSelectPrevious(fn) {
    return this.emitter.on("did-select-previous", fn);
  }

  onDidSelectPageUp(fn) {
    return this.emitter.on("did-select-page-up", fn);
  }

  onDidSelectPageDown(fn) {
    return this.emitter.on("did-select-page-down", fn);
  }

  onDidSelectTop(fn) {
    return this.emitter.on("did-select-top", fn);
  }

  onDidSelectBottom(fn) {
    return this.emitter.on("did-select-bottom", fn);
  }

  onDidCancel(fn) {
    return this.emitter.on("did-cancel", fn);
  }

  onDidDispose(fn) {
    return this.emitter.on("did-dispose", fn);
  }

  onDidChangeItems(fn) {
    return this.emitter.on("did-change-items", fn);
  }

  onDidChangeItem(fn) {
    return this.emitter.on("did-change-item", fn);
  }

  isActive() {
    return this.activeEditor != null;
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

  // The popup hangs from the beginning of the prefix, so that its rows line up
  // with the word being completed — but the pointer drawn on it belongs at the
  // caret, which is where the reader is looking. The distance between the two
  // is the prefix as it is actually drawn, which only the editor can measure,
  // and it is published where the overlay wrapper inherits it from.
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
    // Twice: this runs on the keystroke, before the editor has rendered the
    // character it inserted, so the caret measures where it was a frame ago.
    // The immediate value is right whenever nothing moved; the second is right
    // once the render has landed.
    publish();
    component.getNextUpdatePromise?.().then(publish);
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

  hide() {
    this.destroyOverlay();
    if (this.activeEditor === null) {
      return;
    }

    if (this.bindings && this.bindings.dispose) {
      this.bindings.dispose();
    }

    this.activeEditor = null;
    return this.activeEditor;
  }

  destroyOverlay() {
    if (this.suggestionMarker && this.suggestionMarker.destroy) {
      this.suggestionMarker.destroy();
    } else if (this.overlayDecoration && this.overlayDecoration.destroy) {
      this.overlayDecoration.destroy();
    }
    const activeEditor = this.activeEditor;
    const editorElement = lumine.views.getView(activeEditor);
    if (editorElement && editorElement.style) {
      editorElement.style.removeProperty("--autocomplete-caret-offset");
    }
    if (editorElement && editorElement.classList) {
      let timestamp = this.lastActiveAt;
      lumine.views.updateDocument(() => {
        // A newer timestamp here means that the menu is open again and we
        // shouldn't remove this class name anymore.
        if (this.lastActiveAt > timestamp) return;
        editorElement.classList.remove("autocomplete-active");
        // If the user clicked on the suggestion, focus moved onto the overlay
        // before it was destroyed, so we'll move it back onto the editor. But
        // first we ensure that this is still the active editor!
        if (lumine.workspace.getActiveTextEditor() === activeEditor) {
          editorElement.focus();
        }
      });
    }
    this.suggestionMarker = undefined;
    this.overlayDecoration = undefined;
    return this.overlayDecoration;
  }

  changeItems(items) {
    this.items = items;
    return this.emitter.emit("did-change-items", this.items);
  }

  replaceItem(oldSuggestion, newSuggestion) {
    if (newSuggestion == null) {
      return;
    }

    if (this.items == null) {
      return;
    }

    let itemChanged = false;
    let itemIndex;

    this.items.forEach((suggestion, idx) => {
      if (suggestion === oldSuggestion) {
        this.items[idx] = newSuggestion;
        itemChanged = true;
        itemIndex = idx;
      }
    });

    if (itemChanged) {
      this.emitter.emit("did-change-item", {
        suggestion: newSuggestion,
        index: itemIndex,
      });
    }
  }

  // Public: Clean up, stop listening to events
  dispose() {
    if (this.subscriptions) {
      this.subscriptions.dispose();
    }

    if (this.bindings && this.bindings.dispose) {
      this.bindings.dispose();
    }
    this.emitter.emit("did-dispose");
    return this.emitter.dispose();
  }
};
