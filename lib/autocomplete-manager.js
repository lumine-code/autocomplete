const BackgroundPreparation = require("./background-preparation");
const { CompositeDisposable, Disposable } = require("lumine");

const ProviderManager = require("./provider-manager");
const SuggestionList = require("./suggestion-list");
const changeText = require("./change-text");

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
    this.updateCurrentEditor = this.updateCurrentEditor.bind(this);
    this.handleCommands = this.handleCommands.bind(this);
    this.findSuggestions = this.findSuggestions.bind(this);
    this.getSuggestionsFromProviders = this.getSuggestionsFromProviders.bind(this);
    this.displaySuggestions = this.displaySuggestions.bind(this);
    this.hideSuggestionList = this.hideSuggestionList.bind(this);

    this.didChangeBuffer = this.didChangeBuffer.bind(this);
    this.didSettleTextInput = this.didSettleTextInput.bind(this);
    this.providerManager = new ProviderManager();
    this.suggestionList = new SuggestionList();
    this.watchedEditors = new WeakSet();
    this.watchedEditorLabels = new WeakMap();
    this.suggestionGeneration = 0;
    // In-flight `getSuggestionDetailsOnSelect` results, so confirming can wait
    // for the detail a provider is still fetching.
    this.pendingDetails = new WeakMap();
  }

  initialize() {
    this.subscriptions = new CompositeDisposable();

    this.providerManager.initialize();
    this.suggestionList.initialize();

    this.subscriptions.add(
      this.providerManager.onDidRemoveProvider((provider) =>
        this.dropProviderSuggestions(provider),
      ),
      this.providerManager,
    );
    this.handleEvents();
    this.handleCommands();
    this.subscriptions.add(
      lumine.workspace.observePanes((pane) => {
        const lease = new CompositeDisposable(
          pane.onDidChangeWindow(() => {
            if (this.editorView && lumine.views.getView(pane).contains(this.editorView)) {
              this.inlineCompletion?.cancel();
              this.cancelSuggestions();
            }
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
    if (this.snippetsManager !== snippetsManager) this.inlineCompletion?.cancel();
    this.snippetsManager = snippetsManager;
  }

  registerInlineCompletionProvider(provider) {
    if (!this.inlineCompletion) {
      const InlineCompletionManager = require("./inline-completion-manager");
      this.inlineCompletion = new InlineCompletionManager(this);
      this.subscriptions.add(this.inlineCompletion);
    }
    return this.inlineCompletion.register(provider);
  }

  captureCompletionContext(editor = this.editor) {
    const buffer = editor?.getBuffer();
    const mode = buffer?.getLanguageMode();
    const cursor = editor?.getLastCursor();
    if (!buffer || !mode || !cursor) return null;
    return {
      editor,
      buffer,
      mode,
      revision: buffer.getTextRevision(),
      path: buffer.getPath(),
      epoch: mode.getSyntaxRequestEpoch?.() ?? mode.getSyntaxGeneration?.(),
      cursor,
      position: cursor.getBufferPosition(),
      selections: editor.getSelectedBufferRanges(),
      generation: this.suggestionGeneration,
    };
  }

  isCompletionContextCurrent(
    context,
    {
      revision = context?.revision,
      allowCursorMovement = false,
      allowSuggestionChanges = false,
    } = {},
  ) {
    if (!context || this.disposed || this.compositionInProgress) return false;
    const { editor, buffer, mode, generation, path, epoch } = context;
    if (
      this.editor !== editor ||
      editor.isDestroyed() ||
      editor.isReadOnly() ||
      editor.getBuffer() !== buffer ||
      buffer.getTextRevision() !== revision ||
      buffer.getPath() !== path ||
      buffer.getLanguageMode() !== mode ||
      (mode.getSyntaxRequestEpoch?.() ?? mode.getSyntaxGeneration?.()) !== epoch ||
      (!allowSuggestionChanges && this.suggestionGeneration !== generation)
    )
      return false;
    if (allowCursorMovement) return true;
    const cursor = editor.getLastCursor();
    const selections = editor.getSelectedBufferRanges();
    return (
      cursor === context.cursor &&
      cursor.getBufferPosition().isEqual(context.position) &&
      selections.length === context.selections.length &&
      selections.every((range, i) => range.isEqual(context.selections[i]))
    );
  }

  updateCurrentEditor(currentEditor, labels) {
    if (currentEditor === this.editor) {
      return;
    }
    this.inlineCompletion?.cancel();
    this.cancelSuggestions();
    this.compositionInProgress = false;
    if (this.editorSubscriptions) {
      this.editorSubscriptions.dispose();
    }
    this.editorSubscriptions = null;

    // Stop tracking editor + buffer
    this.editor = null;
    this.editorView = null;
    this.buffer = null;
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
    this.editorSubscriptions = new CompositeDisposable();

    // Subscribe to buffer events:
    this.editorSubscriptions.add(
      this.buffer.onDidSave((e) => {
        this.bufferSaved(e);
      }),
    );
    this.editorSubscriptions.add(
      this.buffer.onWillReload(() => {
        this.inlineCompletion?.cancel();
        this.triggerCharacter = null;
        this.cancelSuggestions();
      }),
    );
    this.editorSubscriptions.add(
      this.buffer.onDidChangeText(this.didChangeBuffer),
      this.editor.onDidSettleTextInput(this.didSettleTextInput),
      this.editor.onDidChangeGrammar(() => {
        this.inlineCompletion?.cancel();
        this.triggerCharacter = null;
        this.cancelSuggestions();
        lumine.commands.invalidateAvailability();
      }),
    );

    // Watch IME Events To Allow IME To Function Without The Suggestion List Showing
    const compositionStart = () => {
      if (this.editor !== currentEditor) return;
      this.compositionInProgress = true;
      this.inlineCompletion?.cancel();
      this.triggerCharacter = null;
      this.cancelSuggestions();
    };
    const compositionEnd = () => {
      if (this.editor !== currentEditor) return;
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

    this.editorSubscriptions.add(
      this.editor.onDidChangeSelectionRange(({ oldBufferRange, newBufferRange, textChanged }) => {
        if (!oldBufferRange.isEqual(newBufferRange)) this.selectionMoved(textChanged);
      }),
      this.editor.onDidAddCursor(() => this.selectionMoved(false)),
      this.editor.onDidRemoveCursor(() => this.selectionMoved(false)),
    );
    return this.editorSubscriptions.add(
      this.editor.onDidChangePath(() => {
        this.inlineCompletion?.cancel();
        this.isCurrentFileBlackListedCache = null;
        this.cancelSuggestions();
      }),
      this.editor.onDidChangeReadOnly(() => {
        this.inlineCompletion?.cancel();
        this.cancelSuggestions();
        lumine.commands.invalidateAvailability();
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

    const focusListener = () => this.updateCurrentEditor(editor, labels);
    view.addEventListener("focus", focusListener);
    const blurListener = ({ relatedTarget }) => {
      if (this.editor === editor && !view.contains(relatedTarget)) this.updateCurrentEditor(null);
    };
    view.addEventListener("blur", blurListener);

    const registration = new CompositeDisposable(
      new Disposable(() => {
        view.removeEventListener("focus", focusListener);
        view.removeEventListener("blur", blurListener);
        this.watchedEditors.delete(editor);
        this.watchedEditorLabels.delete(editor);
        if (this.editor === editor) {
          this.updateCurrentEditor(null);
        }
        lumine.commands.invalidateAvailability();
      }),
    );
    this.watchedEditors.add(editor);
    this.watchedEditorLabels.set(editor, labels);
    lumine.commands.invalidateAvailability();
    this.subscriptions.add(registration);
    const lease = new Disposable(() => {
      this.subscriptions?.remove(registration);
      registration.dispose();
    });
    registration.add(editor.onDidDestroy(() => lease.dispose()));
    return lease;
  }

  handleEvents() {
    this.subscriptions.add(
      lumine.workspace.observeTextEditors((editor) =>
        this.watchEditor(editor, ["workspace-center"]),
      ),
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
        const report = (error) => console.error("Unable to confirm completion", error);
        try {
          this.confirm(e)?.catch?.(report);
        } catch (error) {
          report(error);
        }
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
          isAvailable: ({ currentTarget }) => {
            const editor = currentTarget.getModel();
            return (
              this.watchedEditors.has(editor) &&
              editor.getGrammar?.() !== lumine.grammars.nullGrammar
            );
          },
          didDispatch: (event) => {
            // The manager only ever acts on the editor it is tracking, so a
            // dispatch from an editor nobody watched — a prompt a package
            // built itself — must not raise the overlay in whichever watched
            // editor held focus last.
            const editor = event.currentTarget.getModel();
            if (!this.watchedEditors.has(editor) || editor.isReadOnly()) return;
            this.updateCurrentEditor(editor, this.watchedEditorLabels.get(editor));
            this.cancelNewSuggestionsRequest();
            let activatedManually = true;
            if (
              event.detail &&
              event.detail.activatedManually !== null &&
              typeof event.detail.activatedManually !== "undefined"
            ) {
              activatedManually = event.detail.activatedManually;
            }
            const activate = () => {
              this.shouldDisplaySuggestions = true;
              return this.findSuggestionsForEvent(activatedManually);
            };
            if (!editor.hasPendingTextInput()) return activate();
            const intent = { controller: new AbortController() };
            this.pendingManualInput = intent;
            return editor
              .whenPendingTextInputSettled({ signal: intent.controller.signal })
              .then((ready) => {
                if (this.pendingManualInput !== intent) return;
                this.pendingManualInput = null;
                if (!ready || this.disposed || this.editor !== editor) {
                  this.cancelSuggestions();
                  return;
                }
                return activate();
              })
              .catch((error) => {
                if (this.pendingManualInput !== intent) return;
                this.pendingManualInput = null;
                this.cancelSuggestions();
                console.error("Unable to prepare completion input", error);
              });
          },
        },
      }),
      lumine.commands.add("lumine-text-editor:not([mini]):not([readonly])", {
        "autocomplete:request-inline-completion": {
          description: "Request an inline suggestion at the cursor.",
          isAvailable: ({ currentTarget }) =>
            Boolean(this.inlineCompletion?.canRequest(currentTarget.getModel())),
          didDispatch: ({ currentTarget }) => {
            const editor = currentTarget.getModel();
            if (!this.inlineCompletion?.canRequest(editor)) return false;
            this.updateCurrentEditor(editor, this.watchedEditorLabels.get(editor));
            this.cancelSuggestions();
            return this.inlineCompletion.request(editor, "invoked");
          },
        },
        "autocomplete:accept-inline-completion": {
          description: "Insert the inline suggestion into the document.",
          isAvailable: ({ currentTarget }) =>
            Boolean(this.inlineCompletion?.canAccept(currentTarget.getModel())),
          didDispatch: ({ currentTarget }) =>
            this.inlineCompletion?.accept(currentTarget.getModel()),
        },
        "autocomplete:cancel-inline-completion": {
          description: "Dismiss the inline suggestion and cancel its request.",
          isAvailable: ({ currentTarget }) =>
            Boolean(this.inlineCompletion?.hasRequest(currentTarget.getModel())),
          didDispatch: () => this.inlineCompletion?.cancel(),
        },
        "autocomplete:next-inline-completion": {
          description: "Show the next inline suggestion from the provider.",
          isAvailable: ({ currentTarget }) =>
            Boolean(this.inlineCompletion?.canCycle(currentTarget.getModel())),
          didDispatch: ({ currentTarget }) =>
            this.inlineCompletion?.cycle(currentTarget.getModel()),
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
    if (this.editor.getGrammar?.() === lumine.grammars.nullGrammar) return;
    if (completionRuntime) return completionRuntime.findSuggestions.apply(this, args);
    const context = this.captureCompletionContext();
    return this.prepareCompletion(true).then((runtime) => {
      if (!runtime || !this.isCompletionContextCurrent(context)) return;
      return runtime.findSuggestions.apply(this, args);
    });
  }

  getSuggestionsFromProviders(...args) {
    return getCompletionRuntime().getSuggestionsFromProviders.apply(this, args);
  }

  // Event emitters and timers do not await a returned request. Keep their
  // failures owned here while explicit findSuggestions callers can still
  // observe rejection themselves.
  findSuggestionsForEvent(...args) {
    const editor = this.editor;
    const generation = this.suggestionGeneration;
    const failed = (error) => {
      if (
        this.disposed ||
        this.editor !== editor ||
        this.suggestionGeneration !== generation ||
        error?.name === "AbortError"
      )
        return;
      this.cancelSuggestions();
      console.error("Unable to request completions", error);
    };
    try {
      const pending = this.findSuggestions(...args);
      return pending?.catch ? pending.catch(failed) : pending;
    } catch (error) {
      failed(error);
    }
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
    const editor = this.editor;
    const generation = this.suggestionGeneration;
    const list = this.suggestionList;
    const shouldDisplay = this.shouldDisplaySuggestions;
    list.changeItems(suggestions, { preserveSelection: options?.preserveSelection });
    // Selecting/rendering a new item calls package code synchronously. It can
    // confirm, dismiss, switch editors or start another request before show.
    if (
      this.disposed ||
      this.editor !== editor ||
      this.suggestionGeneration !== generation ||
      this.suggestionList !== list ||
      list.items !== suggestions ||
      this.shouldDisplaySuggestions !== shouldDisplay ||
      (options?.isCurrentRequest && !options.isCurrentRequest())
    )
      return;
    this.inlineCompletion?.cancel();
    return list.show(editor, options);
  }

  dropProviderSuggestions(provider) {
    const list = this.suggestionList;
    if (!list?.items?.some((item) => item.provider === provider)) return;
    const items = list.items.filter((item) => item.provider !== provider);
    list.changeItems(items.length ? items : null, { preserveSelection: true });
    if (!items.length) list.hide();
  }

  hideSuggestionList() {
    this.pendingManualInput?.controller.abort();
    this.pendingManualInput = null;
    if (this.disposed) {
      return;
    }
    this.suggestionRequest?.close();
    this.suggestionList.changeItems(null);
    this.suggestionList.hide();
    this.shouldDisplaySuggestions = false;
  }

  cancelSuggestions() {
    this.triggerCharacter = null;
    this.cancelNewSuggestionsRequest();
    this.hideSuggestionList();
  }

  // Private: Replaces the current prefix with the given match.
  //
  // match - The match to replace the current prefix with
  replaceTextWithMatch(...args) {
    return getCompletionRuntime().replaceTextWithMatch.apply(this, args);
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
    this.shouldDisplaySuggestions = true;

    if (delay) {
      this.delayTimeout = setTimeout(() => {
        this.delayTimeout = null;
        this.findSuggestionsForEvent();
      }, delay);
    } else {
      this.findSuggestionsForEvent();
    }
  }

  cancelNewSuggestionsRequest() {
    this.pendingManualInput?.controller.abort();
    this.pendingManualInput = null;
    this.confirmation?.controller.abort();
    this.activeSuggestionDetail?.controller.abort();
    this.suggestionRequest?.close();
    this.suggestionRequest = null;
    this.suggestionContext = null;
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

  selectionMoved(textChanged) {
    if (!textChanged && !this.applyingCompletionEdit) this.inlineCompletion?.cancel();
    if (
      !textChanged &&
      !this.pendingManualInput &&
      !this.applyingCompletionEdit &&
      !this.editor?.isApplyingTextInput()
    )
      this.cancelSuggestions();
  }

  bufferSaved() {
    if (!this.autosaveEnabled) this.cancelSuggestions();
  }

  didChangeBuffer({ origin }) {
    if (this.applyingCompletionEdit) return;
    this.inlineCompletion?.cancel();
    if (origin === "edit" && this.editor?.isApplyingTextInput()) {
      // Keep the displayed item available for an immediately following
      // commit character. Earlier asynchronous work no longer owns this text.
      this.suggestionRequest?.close();
      this.suggestionAbortController?.abort();
      this.confirmation?.controller.abort();
      clearTimeout(this.delayTimeout);
      this.delayTimeout = null;
      return;
    }
    this.cancelSuggestions();
  }

  didSettleTextInput(input) {
    if (
      this.disposed ||
      this.applyingCompletionEdit ||
      !this.editor ||
      this.editor.isReadOnly() ||
      this.compositionInProgress ||
      this.editor.getGrammar() === lumine.grammars.nullGrammar ||
      this.buffer.getTextRevision() !== input.afterRevision
    )
      return;
    if (this.pendingManualInput) return;
    if (input.kind === "paste") {
      this.cancelSuggestions();
      return;
    }
    this.inlineCompletion?.schedule(this.editor);
    if (completionRuntime) {
      this.processTextInput(input);
      return;
    }
    this.cancelNewSuggestionsRequest();
    const context = this.captureCompletionContext();
    this.prepareCompletion(true)
      .then((runtime) => {
        if (runtime && this.isCompletionContextCurrent(context)) this.processTextInput(input);
      })
      .catch((error) => console.error("Unable to prepare completions", error));
  }

  processTextInput({ kind, text, changes, beforeRevision }) {
    const typed = text && text.length <= 2 && [...text].length === 1 ? text : null;
    const character = kind === "insert" ? typed : null;
    const [change] = changes;
    const commitSuggestion =
      character &&
      changes.length === 1 &&
      changeText.source(change, "oldText").length === 0 &&
      change.newRange.containsPoint(this.editor.getLastCursor().getBufferPosition()) &&
      this.suggestionForCommitCharacter(character);
    if (commitSuggestion) {
      const context = this.captureCompletionContext();
      this.triggerCharacter = null;
      this.confirmWithCommitCharacter(commitSuggestion, character, change.newRange, {
        previousRevision: beforeRevision,
      })
        ?.then((committed) => {
          if (!committed && this.isCompletionContextCurrent(context))
            this.refreshAfterCommitCharacter(character);
        })
        .catch((error) => console.error("Unable to confirm completion", error));
      return;
    }

    if (kind === "delete") {
      const cursor = this.editor.getLastCursor();
      const scope = cursor.getScopeDescriptor();
      const prefix = this.getPrefix(this.editor, cursor.getBufferPosition(), scope);
      const minimum = lumine.config.get("autocomplete.minimumWordLength", { scope });
      if (prefix.trim().length < minimum) {
        this.cancelSuggestions();
        return;
      }
    }
    const isActive = this.suggestionList.isActive();
    const userTyped = typed === " " || Boolean(typed?.trim());
    const userDeleted =
      kind === "delete" &&
      (this.backspaceTriggersAutocomplete || isActive) &&
      changes.some((edit) =>
        changeText.inputCharacter(changeText.source(edit, "oldText"), this.bracketMatcherPairs),
      );
    this.refreshAfterInput(
      character,
      (isActive || this.autoActivationEnabled) && (userTyped || userDeleted),
    );
  }

  refreshAfterInput(character, autoActivate) {
    this.triggerCharacter = this.isTriggerCharacter(character) ? character : null;
    if (
      (this.triggerCharacter || autoActivate) &&
      !this.shouldSuppressActivationForEditorClasses()
    ) {
      this.requestNewSuggestions();
    } else {
      this.cancelSuggestions();
    }
  }

  refreshAfterCommitCharacter(character) {
    this.refreshAfterInput(character, false);
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

  // Resolve and apply the completion against the revision that received the commit character.
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
    this.editor = null;
    this.editorView = null;
    this.editorLabels = null;
    this.buffer = null;
    this.suggestionList = null;
    this.providerManager = null;
  }
};
