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
    this.activeEditor = null;
    this.items = null;
    this.displayedItems = [];
    this.maxItems = 200;
    this.selectedIndex = -1;
    this.explicitSelection = false;
    this.settledDetails = new WeakSet();
  }

  initialize() {
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();

    this.subscriptions.add(
      lumine.commands.add("lumine-text-editor.autocomplete-active:not([readonly])", {
        "autocomplete:confirm": {
          description: "Insert the suggestion now highlighted.",
          isAvailable: ({ currentTarget }) => this.canConfirm(currentTarget),
          didDispatch: this.confirmSelection,
        },
        "autocomplete:confirm-if-non-default": {
          description: "Insert the suggestion, unless it is the one already there.",
          isAvailable: ({ currentTarget }) => this.canConfirm(currentTarget),
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
    this.subscriptions.add(
      lumine.config.observe("autocomplete.maxSuggestions", (limit) => {
        if (!Number.isInteger(limit) || limit < 1 || limit === this.maxItems) return;
        this.maxItems = limit;
        if (this.items?.length) this.changeItems(this.items, { preserveSelection: true });
      }),
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
    if (!this.isActive()) return;
    const suggestion = this.getSelectedItem();
    return suggestion ? this.confirm(suggestion) : this.cancel();
  }

  confirmSelectionIfNonDefault(event) {
    if (!this.isActive()) return;
    if (this.hasExplicitSelection()) return this.confirmSelection();
    this.cancel();
    return event.abortKeyBinding();
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

  onDidChangeSelection(fn) {
    return this.emitter.on("did-change-selection", fn);
  }

  onDidSettleDetails(fn) {
    return this.emitter.on("did-settle-details", fn);
  }

  isActive() {
    return this.activeEditor != null;
  }

  canConfirm(editorElement) {
    return this.overlayEditorElement === editorElement && Boolean(this.getSelectedItem());
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
    return this.destroyOverlay();
  }

  destroyOverlay() {
    const activeEditor = this.activeEditor;
    if (!activeEditor) return;
    const editorElement = this.overlayEditorElement;
    const view = this._suggestionListElement;
    const focusWasInPopup = view?.element.contains(editorElement?.ownerDocument.activeElement);
    const marker = this.suggestionMarker;
    const decoration = this.overlayDecoration;
    this.activeEditor = null;
    this.overlayEditorElement = null;
    this.displayBufferPosition = null;
    this.suggestionMarker = undefined;
    this.overlayDecoration = undefined;
    this.bindings?.dispose();
    this.bindings = null;
    view?.clearInputAccessibility();
    editorElement?.style.removeProperty("--autocomplete-caret-offset");
    editorElement?.classList.remove("autocomplete-active");
    if (marker) marker.destroy();
    else decoration?.destroy();
    // Blur to a sibling control already handed it focus. Restore focus only
    // when removing the popup itself took it away from a documentation link.
    if (focusWasInPopup) {
      lumine.views.updateDocument(() => {
        if (
          !this.activeEditor &&
          editorElement.isConnected &&
          editorElement.ownerDocument.activeElement === editorElement.ownerDocument.body
        )
          editorElement.focus();
      });
    }
  }

  changeItems(items, { preserveSelection = false } = {}) {
    const previous = this.getSelectedItem();
    let retained;
    if (preserveSelection && this.explicitSelection) {
      const { getCompletionItemIdentity } = require("./completion-item");
      const identity = getCompletionItemIdentity(previous);
      retained = items?.find((item) => getCompletionItemIdentity(item) === identity);
    }
    const displayedItems = items?.slice(0, this.maxItems) ?? [];
    if (retained && !displayedItems.includes(retained))
      displayedItems[displayedItems.length - 1] = retained;

    this.items = items;
    this.displayedItems = displayedItems;
    this.explicitSelection = Boolean(retained);
    this.selectedIndex = retained
      ? displayedItems.indexOf(retained)
      : displayedItems.length
        ? Math.max(
            0,
            displayedItems.findIndex((item) => item.preselect),
          )
        : -1;

    const selected = this.getSelectedItem();
    this.emitter.emit("did-change-items", items);
    if (
      selected &&
      this.displayedItems === displayedItems &&
      this.getSelectedItem() === selected &&
      (!preserveSelection || selected !== previous)
    )
      this.select(selected);
  }

  getSelectedItem() {
    return this.displayedItems[this.selectedIndex];
  }

  hasExplicitSelection() {
    return this.explicitSelection;
  }

  hasSettledDetails(suggestion) {
    return this.settledDetails.has(suggestion);
  }

  noteDetailsSettled(suggestion) {
    this.settledDetails.add(suggestion);
    this.emitter.emit("did-settle-details", suggestion);
  }

  setSelectedIndex(index) {
    const selected = this.displayedItems[index];
    if (!selected) return;

    const previousIndex = this.selectedIndex;
    const lastIndex = this.displayedItems.length - 1;
    const unpin = index !== lastIndex && this.displayedItems[lastIndex] !== this.items[lastIndex];
    if (unpin) this.displayedItems[lastIndex] = this.items[lastIndex];

    this.selectedIndex = index;
    this.explicitSelection = true;
    this.emitter.emit("did-change-selection", { previousIndex, unpin });
    if (this.getSelectedItem() === selected) this.select(selected);
  }

  replaceItem(oldSuggestion, newSuggestion) {
    if (newSuggestion == null) {
      return;
    }

    if (this.items == null) {
      return;
    }
    const index = this.items.indexOf(oldSuggestion);
    if (index < 0) return;
    this.items[index] = newSuggestion;
    this.settledDetails.add(newSuggestion);
    const displayIndex = this.displayedItems.indexOf(oldSuggestion);
    if (displayIndex >= 0) {
      this.displayedItems[displayIndex] = newSuggestion;
      this.emitter.emit("did-change-item", {
        suggestion: newSuggestion,
        index: displayIndex,
      });
    }
  }

  // Public: Clean up, stop listening to events
  dispose() {
    if (this.overlayEditorElement) this.destroyOverlay();
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
