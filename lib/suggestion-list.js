let runtime;
const getRuntime = () => (runtime ||= require("./suggestion-list-runtime"));

const { Emitter, CompositeDisposable } = require("lumine");

// The popup hangs below the word being completed, and it outranks every other
// overlay for that space: it is the surface the reader is driving, and its rows
// line up with the prefix. Anything else sharing the line takes the other side
// of it, or steps past it. See `side` and `priority` on `decorateMarker`.

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
      lumine.commands.add("lumine-text-editor.autocomplete-active:not([readonly])", {
        "autocomplete:confirm": {
          description: "Insert the suggestion now highlighted.",
          didDispatch: this.confirmSelection,
        },
        "autocomplete:confirm-if-non-default": {
          description: "Insert the suggestion, unless it is the one already there.",
          didDispatch: this.confirmSelectionIfNonDefault,
        },
      }),
    );
    this.subscriptions.add(
      lumine.config.observe(
        "autocomplete.enableExtendedUnicodeSupport",
        (enableExtendedUnicodeSupport) => {
          if (enableExtendedUnicodeSupport) {
            const { UnicodeLetters } = require("./unicode-helpers");
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
      const SuggestionListElement = require("./suggestion-list-element");
      this._suggestionListElement = new SuggestionListElement(this);
    }

    return this._suggestionListElement;
  }

  addBindings(...args) {
    return getRuntime().addBindings.apply(this, args);
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

  show(...args) {
    return getRuntime().show.apply(this, args);
  }

  showAtBeginningOfPrefix(...args) {
    return getRuntime().showAtBeginningOfPrefix.apply(this, args);
  }

  // The popup hangs from the beginning of the prefix, so that its rows line up
  // with the word being completed — but the pointer drawn on it belongs at the
  // caret, which is where the reader is looking. The distance between the two
  // is the prefix as it is actually drawn, which only the editor can measure,
  // and it is published where the overlay wrapper inherits it from.
  updateCaretOffset(...args) {
    return getRuntime().updateCaretOffset.apply(this, args);
  }

  showAtCursorPosition(...args) {
    return getRuntime().showAtCursorPosition.apply(this, args);
  }

  setOverlaySide(...args) {
    return getRuntime().setOverlaySide.apply(this, args);
  }

  refitOverlay(...args) {
    return getRuntime().refitOverlay.apply(this, args);
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
