const BackgroundPreparation = require("./background-preparation");
const { CompositeDisposable, Disposable } = require("lumine");

const ProviderManager = require("./provider-manager");
const SuggestionList = require("./suggestion-list");
const MARKER_LAYERS_FOR_EDITORS = new WeakMap();

function findOrCreateMarkerLayerForEditor(editor) {
  let layer = MARKER_LAYERS_FOR_EDITORS.get(editor);
  if (!layer) {
    layer = editor.addMarkerLayer();
    MARKER_LAYERS_FOR_EDITORS.set(editor, layer);
  }
  return layer;
}

let completionRuntime;
const getCompletionRuntime = () => (completionRuntime ||= require("./completion-runtime"));

module.exports = class AutocompleteManager {
  constructor() {
    this.autosaveEnabled = false;
    this.backspaceTriggersAutocomplete = true;
    this.autoConfirmSingleSuggestionEnabled = true;
    this.bracketMatcherPairs = ["()", "[]", "{}", '""', "''", "``", "“”", "‘’", "«»", "‹›"];
    this.buffer = null;
    this.compositionInProgress = false;
    this.disposed = false;
    this.editor = null;
    this.editorLabels = null;
    this.editorSubscriptions = null;
    this.editorView = null;
    this.providerManager = null;
    this.ready = false;
    this.subscriptions = null;
    this.suggestionList = null;
    this.suppressForClasses = [];
    this.shouldDisplaySuggestions = false;
    // The character that opened the list on the last buffer change, when a
    // provider declared it as a trigger. Handed to `getSuggestions`.
    this.triggerCharacter = null;
    // Set while a commit character is being applied. The undo, the insertion
    // and the re-typed character it makes are our own edits, and must not be
    // read back as the user typing.
    this.confirmingCommitCharacter = false;
    this.prefixRegex = null;
    this.wordPrefixRegex = null;
    this.updateCurrentEditor = this.updateCurrentEditor.bind(this);
    this.handleCommands = this.handleCommands.bind(this);
    this.findSuggestions = this.findSuggestions.bind(this);
    this.getSuggestionsFromProviders = this.getSuggestionsFromProviders.bind(this);
    this.displaySuggestions = this.displaySuggestions.bind(this);
    this.hideSuggestionList = this.hideSuggestionList.bind(this);

    this.showOrHideSuggestionListForBufferChanges =
      this.showOrHideSuggestionListForBufferChanges.bind(this);
    this.providerManager = new ProviderManager();
    this.suggestionList = new SuggestionList();
    this.watchedEditors = new WeakSet();
    this.watchedEditorLabels = new WeakMap();
    this.suggestionGeneration = 0;
    this.bufferChangeGeneration = 0;
    // In-flight `getSuggestionDetailsOnSelect` results, so confirming can wait
    // for the detail a provider is still fetching.
    this.pendingDetails = new WeakMap();
  }

  initialize() {
    this.subscriptions = new CompositeDisposable();

    this.providerManager.initialize();
    this.suggestionList.initialize();

    this.subscriptions.add(
      lumine.config.observe(
        "autocomplete.enableExtendedUnicodeSupport",
        (enableExtendedUnicodeSupport) => {
          if (enableExtendedUnicodeSupport) {
            const { UnicodeLetters } = require("./unicode-helpers");
            this.prefixRegex = new RegExp(
              `(['"~\`!@#\\$%^&*\\(\\)\\{\\}\\[\\]=+,/\\?>])?(([${UnicodeLetters}\\d_]+[${UnicodeLetters}\\d_-]*)|([.:;[{(< ]+))$`,
            );
            this.wordPrefixRegex = new RegExp(
              `^[${UnicodeLetters}\\d_]+[${UnicodeLetters}\\d_-]*$`,
            );
          } else {
            this.prefixRegex = /(\b|['"~`!@#$%^&*(){}[\]=+,/?>])((\w+[\w-]*)|([.:;[{(< ]+))$/;
            this.wordPrefixRegex = /^\w+[\w-]*$/;
          }
        },
      ),
    );
    this.subscriptions.add(this.providerManager);
    this.handleEvents();
    this.handleCommands();
    this.subscriptions.add(
      lumine.workspace.observePanes((pane) => {
        const lease = new CompositeDisposable(
          pane.onDidChangeWindow(() => {
            if (this.editorView && lumine.views.getView(pane).contains(this.editorView))
              this.cancelSuggestions();
          }),
        );
        lease.add(
          pane.onDidDestroy(() => {
            lease.dispose();
            this.subscriptions?.remove(lease);
          }),
        );
        this.subscriptions.add(lease);
      }),
    );
    this.subscriptions.add(this.suggestionList); // We're adding this last so it is disposed after events
    this.ready = true;
  }

  setSnippetsManager(snippetsManager) {
    this.snippetsManager = snippetsManager;
  }

  updateCurrentEditor(currentEditor, labels) {
    if (currentEditor === this.editor) {
      return;
    }
    this.cancelSuggestions();
    if (this.editorSubscriptions) {
      this.editorSubscriptions.dispose();
    }
    this.editorSubscriptions = null;

    // Stop tracking editor + buffer
    this.editor = null;
    this.editorView = null;
    this.buffer = null;
    this.markerLayer = null;
    this.isCurrentFileBlackListedCache = null;

    if (!this.editorIsValid(currentEditor)) {
      return;
    }

    // Track the new editor, editorView, and buffer and set
    // the labels for its providers.
    this.editor = currentEditor;
    this.editorLabels = labels;
    this.editorView = lumine.views.getView(this.editor);
    this.buffer = this.editor.getBuffer();
    this.markerLayer = findOrCreateMarkerLayerForEditor(this.editor);

    this.editorSubscriptions = new CompositeDisposable();

    // Subscribe to buffer events:
    this.editorSubscriptions.add(
      this.buffer.onDidSave((e) => {
        this.bufferSaved(e);
      }),
    );
    this.editorSubscriptions.add(
      this.buffer.onWillReload(() => {
        this.triggerCharacter = null;
        this.cancelSuggestions();
      }),
    );
    this.editorSubscriptions.add(
      this.buffer.onDidChangeText(this.showOrHideSuggestionListForBufferChanges),
      this.editor.onDidChangeGrammar(() => {
        this.triggerCharacter = null;
        this.cancelSuggestions();
      }),
    );

    // Watch IME Events To Allow IME To Function Without The Suggestion List Showing
    const compositionStart = () => {
      this.compositionInProgress = true;
    };
    const compositionEnd = () => {
      this.compositionInProgress = false;
    };

    this.editorView.addEventListener("compositionstart", compositionStart);
    this.editorView.addEventListener("compositionend", compositionEnd);
    this.editorSubscriptions.add(
      new Disposable(() => {
        if (this.editorView) {
          this.editorView.removeEventListener("compositionstart", compositionStart);
          this.editorView.removeEventListener("compositionend", compositionEnd);
        }
      }),
    );

    // Subscribe to editor events:
    // Close the overlay when the cursor moved without changing any text
    this.editorSubscriptions.add(
      this.editor.onDidChangeCursorPosition((e) => {
        if (e.cursor !== this.editor.getLastCursor()) return;
        this.cursorMoved(e);
      }),
    );
    return this.editorSubscriptions.add(
      this.editor.onDidChangePath(() => {
        this.isCurrentFileBlackListedCache = null;
      }),
    );
  }

  editorIsValid(editor) {
    return lumine.workspace.isTextEditor(editor);
  }

  // Makes the autocomplete manager watch the `editor`.
  // When the watched `editor` is focused, it will provide autocompletions from
  // providers with the given `labels`.
  //
  // Returns a {Disposable} to stop watching the `editor`.
  watchEditor(editor, labels) {
    if (this.watchedEditors.has(editor)) return;
    this.prepareCompletion().catch(console.error);

    let view = lumine.views.getView(editor);

    if (view.hasFocus()) {
      this.updateCurrentEditor(editor, labels);
    }

    let focusListener = (_element) => this.updateCurrentEditor(editor, labels);
    view.addEventListener("focus", focusListener);
    let blurListener = (_element) => this.hideSuggestionList();
    view.addEventListener("blur", blurListener);

    let disposable = new Disposable(() => {
      view.removeEventListener("focus", focusListener);
      view.removeEventListener("blur", blurListener);
      if (this.editor === editor) {
        this.updateCurrentEditor(null);
      }
    });
    this.watchedEditors.add(editor);
    this.watchedEditorLabels.set(editor, labels);
    lumine.commands.invalidateAvailability();
    this.subscriptions.add(disposable);
    return new Disposable(() => {
      disposable.dispose();
      if (this.subscriptions != null) {
        this.subscriptions.remove(disposable);
      }
      this.watchedEditors.delete(editor);
      this.watchedEditorLabels.delete(editor);
      lumine.commands.invalidateAvailability();
    });
  }

  handleEvents() {
    this.subscriptions.add(
      lumine.workspace.observeTextEditors((editor) => {
        const disposable = this.watchEditor(editor, ["workspace-center"]);
        editor.onDidDestroy(() => disposable.dispose());
      }),
    );

    // Watch config values
    this.subscriptions.add(
      lumine.config.observe("autosave.enabled", (value) => {
        this.autosaveEnabled = value;
      }),
    );
    this.subscriptions.add(
      lumine.config.observe("autocomplete.backspaceTriggersAutocomplete", (value) => {
        this.backspaceTriggersAutocomplete = value;
      }),
    );
    this.subscriptions.add(
      lumine.config.observe("autocomplete.enableAutoActivation", (value) => {
        this.autoActivationEnabled = value;
      }),
    );
    this.subscriptions.add(
      lumine.config.observe("autocomplete.enableAutoConfirmSingleSuggestion", (value) => {
        this.autoConfirmSingleSuggestionEnabled = value;
      }),
    );
    this.subscriptions.add(
      lumine.config.observe("autocomplete.consumeSuffix", (value) => {
        this.consumeSuffix = value;
      }),
    );
    this.subscriptions.add(
      lumine.config.observe("autocomplete.fileBlacklist", (value) => {
        if (value) {
          this.fileBlacklist = value.map((s) => {
            return s.trim();
          });
        }
        this.isCurrentFileBlackListedCache = null;
      }),
    );
    this.subscriptions.add(
      lumine.config.observe("autocomplete.suppressActivationForEditorClasses", (value) => {
        this.suppressForClasses = [];
        for (let i = 0; i < value.length; i++) {
          const selector = value[i];
          const classes = selector
            .trim()
            .split(".")
            .filter((className) => className.trim())
            .map((className) => className.trim());
          if (classes.length) {
            this.suppressForClasses.push(classes);
          }
        }
      }),
    );

    // Handle events from suggestion list
    this.subscriptions.add(
      this.suggestionList.onDidConfirm((e) => {
        this.confirm(e)?.catch?.((error) => console.error("Unable to confirm completion", error));
      }),
    );
    this.subscriptions.add(this.suggestionList.onDidCancel(() => this.cancelSuggestions()));
    this.subscriptions.add(
      this.suggestionList.onDidSelect((suggestion) => {
        this.getDetailsOnSelect(suggestion);
      }),
    );
  }

  handleCommands() {
    return this.subscriptions.add(
      // Watched mini editors have the same completion controls as pane editors.
      lumine.commands.add("lumine-text-editor", {
        "autocomplete:cancel": {
          description: "Close the suggestion list without taking anything.",
          didDispatch: (event) => {
            if (event.currentTarget.getModel() !== this.editor) return;
            this.suggestionList.cancel();
          },
        },
      }),
      lumine.commands.add("lumine-text-editor:not([readonly])", {
        "autocomplete:activate": {
          description: "Open the suggestion list without waiting for a keystroke.",
          isAvailable: ({ currentTarget }) => this.watchedEditors.has(currentTarget.getModel()),
          didDispatch: (event) => {
            // The manager only ever acts on the editor it is tracking, so a
            // dispatch from an editor nobody watched — a prompt a package
            // built itself — must not raise the overlay in whichever watched
            // editor held focus last.
            const editor = event.currentTarget.getModel();
            if (!this.watchedEditors.has(editor) || editor.isReadOnly()) return;
            this.updateCurrentEditor(editor, this.watchedEditorLabels.get(editor));
            this.cancelNewSuggestionsRequest();
            this.cancelHideSuggestionListRequest();
            this.shouldDisplaySuggestions = true;
            let activatedManually = true;
            if (
              event.detail &&
              event.detail.activatedManually !== null &&
              typeof event.detail.activatedManually !== "undefined"
            ) {
              activatedManually = event.detail.activatedManually;
            }
            this.findSuggestions(activatedManually);
          },
        },
      }),
      lumine.commands.add("lumine-text-editor", {
        "autocomplete:navigate-to-description-more-link": {
          description: "Follow the documentation link beside the suggestion.",
          isAvailable: ({ currentTarget }) =>
            Boolean(this.descriptionLink(currentTarget.getModel())),
          didDispatch: ({ currentTarget }) => {
            const link = this.descriptionLink(currentTarget.getModel());
            if (link) {
              void lumine.shell.openExternal(link.href).catch((error) => {
                lumine.notifications.addWarning("Unable to open the completion documentation.", {
                  detail: error.message,
                  dismissable: true,
                });
              });
            }
          },
        },
      }),
    );
  }

  descriptionLink(editor) {
    if (!editor || editor !== this.editor) return null;
    const container = this.editorView?.querySelector(".suggestion-description");
    if (!container || container.inert || container.style.display !== "block") return null;
    const link = container.querySelector(".suggestion-description-more-link");
    return link?.style.display !== "none" && link?.href ? link : null;
  }

  prepareCompletion(urgent = false) {
    this.providerManager?.prepare(urgent)?.catch(console.error);
    // Preparing a popup must not postpone provider work. It can use idle
    // time while data is being fetched; show() remains the synchronous fallback.
    this.popupPreparation ||= new BackgroundPreparation([
      () => require("./snippet-parser"),
      () => require("./suggestion-list-element"),
      () => require("./suggestion-list-runtime"),
    ]);
    this.popupPreparation.prepare().catch(console.error);
    this.completionPreparation ||= new BackgroundPreparation([
      () => require("./completion-matches"),
      () => require("./get-additional-word-characters"),
      () => require("./unicode-helpers"),
      () => this.fileBlacklist?.length && require("picomatch"),
      () => getCompletionRuntime(),
    ]);
    return this.completionPreparation.prepare(urgent);
  }

  // Private: Finds suggestions for the current prefix, sets the list items,
  // positions the overlay and shows it
  findSuggestions(...args) {
    if (this.disposed || this.providerManager == null || this.editor == null || this.buffer == null)
      return;
    this.suggestionActivationManual = Boolean(args[0]);
    if (completionRuntime) return completionRuntime.findSuggestions.apply(this, args);
    const generation = this.suggestionGeneration;
    const editor = this.editor;
    return this.prepareCompletion(true).then((runtime) => {
      if (
        !runtime ||
        this.disposed ||
        this.editor !== editor ||
        this.suggestionGeneration !== generation
      )
        return;
      return runtime.findSuggestions.apply(this, args);
    });
  }

  getSuggestionsFromProviders(...args) {
    return getCompletionRuntime().getSuggestionsFromProviders.apply(this, args);
  }

  filterSuggestions(...args) {
    return getCompletionRuntime().filterSuggestions.apply(this, args);
  }

  // providerSuggestions - array of arrays of suggestions provided by all called providers
  mergeSuggestionsFromProviders(...args) {
    return getCompletionRuntime().mergeSuggestionsFromProviders.apply(this, args);
  }

  displaySuggestions(...args) {
    return getCompletionRuntime().displaySuggestions.apply(this, args);
  }

  // Drops a suggestion that inserts the same text as one already in the list
  // and tells the user nothing the first one does not — a buffer word standing
  // behind a real completion of the same name.
  //
  // Matching on the inserted text alone is not enough: the same symbol
  // auto-imported from two different modules inserts identical text and
  // differs only in its label and the import it brings. Collapsing those would
  // silently pick a module for the user, so anything that describes itself
  // differently is kept.
  removeRedundantSuggestions(...args) {
    return getCompletionRuntime().removeRedundantSuggestions.apply(this, args);
  }

  getPrefix(...args) {
    return getCompletionRuntime().getPrefix.apply(this, args);
  }

  getWordCharacterRegex(...args) {
    return getCompletionRuntime().getWordCharacterRegex.apply(this, args);
  }

  getLegacyPrefix(...args) {
    return getCompletionRuntime().getLegacyPrefix.apply(this, args);
  }

  // Private: Gets called when the user successfully confirms a suggestion
  //
  // match - An {Object} representing the confirmed suggestion
  confirm(...args) {
    if (this.editor == null || this.editor.isReadOnly() || args[0] == null || this.disposed) return;
    return getCompletionRuntime().confirm.apply(this, args);
  }

  insertSuggestion(...args) {
    return getCompletionRuntime().insertSuggestion.apply(this, args);
  }

  // Resolves to the detailed suggestion when the provider answers in time, and
  // to the original otherwise: a slow provider may delay insertion briefly but
  // must never block it.
  awaitDetails(...args) {
    return getCompletionRuntime().awaitDetails.apply(this, args);
  }

  getDetailsOnSelect(...args) {
    if (!args[0]?.provider?.getSuggestionDetailsOnSelect) return;
    return getCompletionRuntime().getDetailsOnSelect.apply(this, args);
  }

  showSuggestionList(suggestions, options) {
    if (this.disposed) {
      return;
    }
    this.suggestionList.changeItems(suggestions);
    return this.suggestionList.show(this.editor, options);
  }

  hideSuggestionList() {
    if (this.disposed) {
      return;
    }
    this.coldInputGeneration = (this.coldInputGeneration || 0) + 1;
    this.suggestionList.changeItems(null);
    this.suggestionList.hide();
    this.shouldDisplaySuggestions = false;
  }

  cancelSuggestions() {
    this.cancelNewSuggestionsRequest();
    this.cancelHideSuggestionListRequest();
    this.hideSuggestionList();
  }

  requestHideSuggestionList(_command) {
    if (this.hideTimeout == null) {
      this.hideTimeout = setTimeout(() => {
        this.hideSuggestionList();
        this.hideTimeout = null;
      }, 0);
    }
    this.shouldDisplaySuggestions = false;
  }

  cancelHideSuggestionListRequest() {
    clearTimeout(this.hideTimeout);
    this.hideTimeout = null;
  }

  // Private: Applies a `TextEdit` to the given editor.
  applyTextEdit(...args) {
    if (this.editor === null) return;
    return getCompletionRuntime().applyTextEdit.apply(this, args);
  }

  // A completion's edit range covers the word being typed and ends at the
  // cursor it was requested for, so the same span — the same number of
  // characters either side — is what every other cursor wants replaced.
  // Without this an edit landed once and the other cursors kept their prefix.
  textEditRangesForCursors(...args) {
    return getCompletionRuntime().textEditRangesForCursors.apply(this, args);
  }

  // Private: Replaces the current prefix with the given match.
  //
  // match - The match to replace the current prefix with
  replaceTextWithMatch(...args) {
    return getCompletionRuntime().replaceTextWithMatch.apply(this, args);
  }

  getSuffix(...args) {
    return getCompletionRuntime().getSuffix.apply(this, args);
  }

  // Private: Checks whether the current file is blacklisted.
  //
  // Returns {Boolean} that defines whether the current file is blacklisted
  isCurrentFileBlackListed(...args) {
    return getCompletionRuntime().isCurrentFileBlackListed.apply(this, args);
  }

  // Private: Gets called when the content has been modified
  requestNewSuggestions() {
    let delay = lumine.config.get("autocomplete.autoActivationDelay");
    this.cancelNewSuggestionsRequest();

    if (delay) {
      this.delayTimeout = setTimeout(() => {
        this.delayTimeout = null;
        this.findSuggestions();
      }, delay);
    } else {
      this.findSuggestions();
    }

    this.shouldDisplaySuggestions = true;
  }

  cancelNewSuggestionsRequest() {
    this.coldBufferInput = null;
    this.suggestionAbortController?.abort();
    this.suggestionAbortController = null;
    if (this.delayTimeout != null) {
      clearTimeout(this.delayTimeout);
    }
    this.delayTimeout = null;
    this.currentSuggestionsPromise = null;
    this.suggestionGeneration++;
    this.shouldDisplaySuggestions = false;
  }

  // Private: Gets called when the cursor has moved. Cancels the autocompletion if
  // the text has not been changed.
  //
  // data - An {Object} containing information on why the cursor has been moved
  cursorMoved({ textChanged }) {
    // The delay is a workaround for the backspace case. The way lumine implements
    // backspace is to select left 1 char, then delete. This results in a
    // cursorMoved event with textChanged == false. So we delay, and if the
    // bufferChanged handler decides to show suggestions, it will cancel the
    // hideSuggestionList request. If there is no bufferChanged event,
    // suggestionList will be hidden.
    if (!textChanged) this.requestHideSuggestionList();
  }

  // Private: Gets called when the user saves the document. Cancels the
  // autocompletion.
  bufferSaved() {
    if (!this.autosaveEnabled) {
      return this.hideSuggestionList();
    }
  }

  showOrHideSuggestionListForBufferChanges({ changes, origin }) {
    if (this.disposed) return;
    this.bufferChangeGeneration++;
    if (origin !== "edit") {
      this.triggerCharacter = null;
      this.cancelSuggestions();
      return;
    }
    if (
      this.editor.isApplyingAutomaticIndentation?.() &&
      changes.length &&
      changes.every(
        (change) =>
          change.oldRange.end.row === change.oldRange.start.row &&
          change.newRange.end.row === change.newRange.start.row &&
          !/[^\t ]/.test(change.oldText) &&
          !/[^\t ]/.test(change.newText),
      )
    ) {
      if (this.continueColdInputAfterIndentation(changes)) return;
      if (this.shouldDisplaySuggestions && this.hideTimeout == null) {
        // A queued timer will read the corrected cursor when it fires.
        if (this.delayTimeout != null) return;
        const manual = this.suggestionActivationManual;
        this.cancelSuggestions();
        this.shouldDisplaySuggestions = true;
        return this.findSuggestions(manual);
      }
      this.cancelNewSuggestionsRequest();
      return;
    }
    if (!completionRuntime) {
      // Cancel an earlier manual request as soon as its text becomes stale,
      // even though processing this edit must wait for the runtime.
      this.cancelNewSuggestionsRequest();
      this.cancelHideSuggestionListRequest();
      const editor = this.editor;
      const input = (this.coldBufferInput = {
        editor,
        cursor: editor.getLastCursor(),
        changes,
        position: editor.getLastCursor().getBufferPosition(),
        generation: this.suggestionGeneration,
        bufferGeneration: this.bufferChangeGeneration,
        coldGeneration: this.coldInputGeneration,
      });
      this.prepareCompletion(true)
        .then((runtime) => {
          if (
            !runtime ||
            this.disposed ||
            this.editor !== editor ||
            this.coldBufferInput !== input ||
            this.suggestionGeneration !== input.generation ||
            this.bufferChangeGeneration !== input.bufferGeneration ||
            this.coldInputGeneration !== input.coldGeneration ||
            !editor.getLastCursor().getBufferPosition().isEqual(input.position)
          )
            return;
          if (input.continued) this.processBufferChanges(changes, true);
          else this.processBufferChanges(changes);
        })
        .catch(console.error)
        .finally(() => {
          if (this.coldBufferInput === input) this.coldBufferInput = null;
        });
      return;
    }
    this.processBufferChanges(changes);
  }

  continueColdInputAfterIndentation(changes) {
    const input = this.coldBufferInput;
    if (
      !input ||
      input.editor !== this.editor ||
      input.cursor !== this.editor.getLastCursor() ||
      input.generation !== this.suggestionGeneration ||
      input.coldGeneration !== this.coldInputGeneration ||
      input.bufferGeneration !== this.bufferChangeGeneration - 1 ||
      this.hideTimeout != null
    )
      return false;
    const position = input.position.copy();
    let preceding;
    for (const change of changes)
      if (
        change.oldRange.start.row === position.row &&
        change.oldRange.start.column <= position.column &&
        (!preceding || change.oldRange.start.column > preceding.oldRange.start.column)
      )
        preceding = change;
    if (preceding)
      position.column =
        Math.max(0, position.column - preceding.oldRange.end.column) +
        preceding.newRange.end.column;
    if (!position.isEqual(input.cursor.getBufferPosition())) return false;
    input.position = position;
    input.bufferGeneration = this.bufferChangeGeneration;
    input.continued = true;
    return true;
  }

  processBufferChanges(changes, continuedInput = false) {
    // Our own edits, not the user's.
    if (this.confirmingCommitCharacter) return;

    const cursor = this.editor.getLastCursor();
    const lastCursorPosition = cursor.getBufferPosition();
    const changeOccurredNearLastCursor = changes.some(({ newRange }) => {
      return newRange.containsPoint(lastCursorPosition);
    });
    if (!changeOccurredNearLastCursor && !continuedInput) return;

    const insertedCharacter = this.insertedCharacterForChanges(changes);

    const commitSuggestion = this.suggestionForCommitCharacter(insertedCharacter);
    if (commitSuggestion) {
      this.triggerCharacter = null;
      this.confirmWithCommitCharacter(
        commitSuggestion,
        insertedCharacter,
        changes[0].newRange,
      )?.catch?.((error) => console.error("Unable to confirm completion", error));
      return;
    }

    this.triggerCharacter = this.isTriggerCharacter(insertedCharacter) ? insertedCharacter : null;

    // Deleting below the minimum ends completion even when an external
    // provider would return suggestions for the remaining (or empty) prefix.
    // Cancel pending requests too, so a late response cannot reopen the list.
    if (changes.some(({ oldText, newText }) => oldText.length > 0 && newText.length === 0)) {
      const scopeDescriptor = cursor.getScopeDescriptor();
      const prefix = this.getPrefix(this.editor, lastCursorPosition, scopeDescriptor);
      const minimumWordLength = lumine.config.get("autocomplete.minimumWordLength", {
        scope: scopeDescriptor,
      });
      if (prefix.trim().length < minimumWordLength) {
        this.cancelSuggestions();
        return;
      }
    }

    // A declared trigger character opens the list on its own terms, so a
    // language server still answers `.` when suggestions on keystroke are off.
    let shouldActivate = this.triggerCharacter != null;
    if (
      !shouldActivate &&
      (this.autoActivationEnabled ||
        (this.suggestionList.isActive() && !this.compositionInProgress))
    ) {
      shouldActivate = changes.some(({ oldText, newText }) => {
        if (this.autoActivationEnabled || this.suggestionList.isActive()) {
          if (newText.length > 0) {
            // Activate on space, a non-whitespace character, or a bracket-matcher pair.
            if (
              newText === " " ||
              newText.trim().length === 1 ||
              (newText.length === 2 && this.bracketMatcherPairs.includes(newText))
            )
              return true;
          } else if (
            oldText.length > 0 &&
            (this.backspaceTriggersAutocomplete || this.suggestionList.isActive())
          ) {
            // Suggestion list must be either active or backspaceTriggersAutocomplete must be true for activation to occur.
            // Activate on removal of a space, a non-whitespace character, or a bracket-matcher pair.
            if (
              oldText === " " ||
              oldText.trim().length === 1 ||
              (oldText.length === 2 && this.bracketMatcherPairs.includes(oldText))
            )
              return true;
          }
        }
      });
    }

    // A suppressed editor stays quiet however the activation was reached.
    if (shouldActivate && this.shouldSuppressActivationForEditorClasses()) shouldActivate = false;

    if (shouldActivate) {
      this.cancelHideSuggestionListRequest();
      this.requestNewSuggestions();
    } else {
      this.cancelNewSuggestionsRequest();
      this.hideSuggestionList();
    }
  }

  // Private: The single character the user just typed, or `null` when the
  // change was anything else — a paste, a deletion, several cursors at once.
  //
  // A bracket matcher answers an opening bracket by inserting the whole pair in
  // one edit, so a two-character pair counts as the character that opened it.
  insertedCharacterForChanges(...args) {
    return getCompletionRuntime().insertedCharacterForChanges.apply(this, args);
  }

  // Private: Whether a provider that applies at the cursor has declared
  // `character` as one that should open the suggestion list.
  //
  // Asked on every keystroke rather than cached: providers are registered and
  // disposed as packages activate, and a language server only advertises its
  // trigger characters once it is running.
  isTriggerCharacter(...args) {
    return getCompletionRuntime().isTriggerCharacter.apply(this, args);
  }

  // Private: The highlighted suggestion when `character` is one it listed as a
  // commit character, and `null` otherwise — including when the feature is off,
  // when no list is showing, and when the suggestion lists no such character.
  suggestionForCommitCharacter(...args) {
    return getCompletionRuntime().suggestionForCommitCharacter.apply(this, args);
  }

  // Private: Accepts `suggestion` because the user typed one of its commit
  // characters: take the character back out, insert the suggestion, then type
  // the character again.
  //
  // Resolve detail before changing the source, then group the three edits into
  // one undo step. `replaceTextWithMatch` transacts within the checkpoint.
  confirmWithCommitCharacter(...args) {
    return getCompletionRuntime().confirmWithCommitCharacter.apply(this, args);
  }

  shouldSuppressActivationForEditorClasses() {
    for (let i = 0; i < this.suppressForClasses.length; i++) {
      const classNames = this.suppressForClasses[i];
      let containsCount = 0;
      for (let j = 0; j < classNames.length; j++) {
        const className = classNames[j];
        if (this.editorView.classList.contains(className)) {
          containsCount += 1;
        }
      }
      if (containsCount === classNames.length) {
        return true;
      }
    }
    return false;
  }

  // Public: Clean up, stop listening to events
  dispose() {
    this.cancelSuggestions();
    this.disposed = true;
    this.completionPreparation?.dispose();
    this.popupPreparation?.dispose();
    this.ready = false;
    if (this.editorSubscriptions) {
      this.editorSubscriptions.dispose();
    }
    this.editorSubscriptions = null;
    if (this.subscriptions) {
      this.subscriptions.dispose();
    }
    this.subscriptions = null;
    this.suggestionList = null;
    this.providerManager = null;
  }
};
