const { Point, Range } = require("lumine");
const path = require("path");
const { createCompletionEditPlan, applyCompletionEditPlan } = require("./completion-edits");
const { matchSuggestion, queryFor } = require("./completion-matches");
const {
  normalizeItem,
  getCompletionItemContext,
  getCompletionItemIdentity,
} = require("./completion-item");
let additionalWordCharacters;
const getAdditionalWordCharacters = (...args) =>
  (additionalWordCharacters ||= require("./get-additional-word-characters"))(...args);

const MAX_PREFIX_LENGTH = 4096;
const wordCharacterRegexCache = new Map();

// Configuration changes invalidate scope-based decisions; publishing another
// viewport of the same syntax tree does not.
function captureSyntaxConfiguration(editor) {
  const buffer = editor.getBuffer();
  const mode = buffer.getLanguageMode();
  const epoch = mode.getSyntaxRequestEpoch?.() ?? mode.getSyntaxGeneration?.();
  return () =>
    !editor.isDestroyed() &&
    editor.getBuffer() === buffer &&
    buffer.getLanguageMode() === mode &&
    (mode.getSyntaxRequestEpoch?.() ?? mode.getSyntaxGeneration?.()) === epoch;
}

// Everything a suggestion shows beyond the text it inserts. Two suggestions
// that insert the same text are the same suggestion to a reader only if these
// match as well.
const shownFacetsOf = (suggestion) =>
  [
    suggestion.displayText,
    suggestion.displayTextDetail,
    suggestion.leftLabel,
    suggestion.leftLabelHTML,
    suggestion.rightLabel,
    suggestion.rightLabelHTML,
    suggestion.description,
    suggestion.descriptionMarkdown,
  ]
    .map((facet) => facet ?? "")
    .join("\0");

const noShownFacets = shownFacetsOf({});

function deduplicationKey(item, word) {
  if (
    item.id != null ||
    item.provider?.getSuggestionDetailsOnSelect ||
    item.provider?.onDidInsertSuggestion
  )
    return null;
  return JSON.stringify([
    word,
    item.textEdit,
    item.ranges,
    item.additionalTextEdits,
    item.insertTextMode,
    item.commitCharacters,
  ]);
}

function addDistinctSuggestion(group, suggestion, builtinProvider, selectedIdentity) {
  const word = JSON.stringify([suggestion.text, suggestion.snippet, suggestion.replacementPrefix]);
  const key = deduplicationKey(suggestion, word);
  const keptFacets = group.effects.get(key);
  const isBuiltinWord =
    builtinProvider != null &&
    suggestion.provider === builtinProvider &&
    !suggestion.textEdit &&
    !suggestion.ranges &&
    !suggestion.additionalTextEdits?.length;
  const facets = key !== null || isBuiltinWord ? shownFacetsOf(suggestion) : null;
  if (
    getCompletionItemIdentity(suggestion) !== selectedIdentity &&
    ((keptFacets && (facets === noShownFacets || keptFacets.has(facets))) ||
      (isBuiltinWord && facets === noShownFacets && group.words.has(word)))
  )
    return false;
  group.words.add(word);
  if (keptFacets) keptFacets.add(facets);
  else if (key !== null) group.effects.set(key, new Set([facets]));
  return true;
}

// How long confirming waits for a provider's in-flight detail request before
// inserting what it already has. Long enough for a warm language server to
// answer with its auto-import edits, short enough not to feel like lag.
const DETAILS_TIMEOUT_MS = 200;

// Why a provider is being asked for suggestions, numbered as LSP's
// `CompletionTriggerKind`. Autocomplete raises these two; the third,
// `3` — a re-request of a list the provider itself marked incomplete — is
// raised by the provider, which is the only side that knows about it.
const TRIGGER_INVOKED = 1;
const TRIGGER_CHARACTER = 2;

// How well a suggestion answers what the user typed. Ranking by tier first
// keeps a literal prefix match above a scattered subsequence one, which a
// single blended score cannot guarantee.
const MATCH_EXACT_PREFIX = 3;
const MATCH_EXACT_WORD = 4;
const MATCH_PREFIX = 2;
const MATCH_SUBSEQUENCE = 1;

// What the typed prefix is matched against. `filterText` wins where a provider
// supplies one (the LSP field for exactly this), then the visible label, and
// only then the inserted text. Scoring the raw snippet body, as this used to,
// matched placeholder names like `${1:name}` rather than the snippet's prefix.
const matchTierFor = (match) => {
  if (match.exact) return MATCH_EXACT_WORD;
  if (match.caseSensitivePrefix) return MATCH_EXACT_PREFIX;
  if (match.prefix) return MATCH_PREFIX;
  return MATCH_SUBSEQUENCE;
};

// Tier, then the provider's own preference (`sortText`, which LSP servers use
// to express relevance), then match strength, then original order. The user's
// typing always outranks the server's opinion; the server decides among items
// that match it equally well.
const compareSuggestions = (a, b) => {
  if (a.matchTier !== b.matchTier) return b.matchTier - a.matchTier;
  if (a.sortText != null || b.sortText != null) {
    const left = a.sortText ?? "";
    const right = b.sortText ?? "";
    // Compared as opaque strings, per the LSP spec — not by locale.
    if (left !== right) return left < right ? -1 : 1;
  }
  if (a.score !== b.score) return b.score - a.score;
  return a.sortIndex - b.sortIndex;
};

function untilAborted(result, signal) {
  let stop;
  const cancelled = new Promise((resolve) => {
    stop = () => resolve(undefined);
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
  return Promise.race([cancelled, result]).finally(() => signal.removeEventListener("abort", stop));
}

// Deferred requires
let picomatch = null;

// Methods keep the manager as their receiver; its public functions remain stable forwarding methods.
class CompletionRuntime {
  findSuggestions(activatedManually) {
    if (this.disposed || this.compositionInProgress) {
      return;
    }
    if (this.providerManager == null || this.editor == null || this.buffer == null) {
      return;
    }
    if (this.editor.getGrammar?.() === lumine.grammars.nullGrammar) return;
    if (this.isCurrentFileBlackListed()) {
      return;
    }
    const requestContext = this.captureCompletionContext();
    if (!this.isCompletionContextCurrent(requestContext)) return;
    const { cursor, position: bufferPosition, editor } = requestContext;
    if (this.buffer.getLanguageMode().asynchronousSyntax) {
      this.suggestionAbortController?.abort();
      const controller = (this.suggestionAbortController = new AbortController());
      const request = editor
        .getScopeDescriptorsForBufferPositions([bufferPosition], { signal: controller.signal })
        .then((scopes) => {
          if (
            !scopes ||
            controller.signal.aborted ||
            !this.isCompletionContextCurrent(requestContext)
          )
            return;
          const scopeDescriptor = scopes[0];
          return this.getSuggestionsFromProviders({
            editor,
            bufferPosition,
            scopeDescriptor,
            prefix: this.getPrefix(editor, bufferPosition, scopeDescriptor),
            activatedManually,
            requestContext,
          });
        })
        .finally(() => {
          if (this.suggestionAbortController === controller) this.suggestionAbortController = null;
        });
      this.currentSuggestionsPromise = request;
      return request;
    }
    const scopeDescriptor = cursor.getScopeDescriptor();
    const prefix = this.getPrefix(editor, bufferPosition, scopeDescriptor);

    return this.getSuggestionsFromProviders({
      editor,
      bufferPosition,
      scopeDescriptor,
      prefix,
      activatedManually,
      requestContext,
    });
  }

  getSuggestionsFromProviders(options) {
    if (this.compositionInProgress) return;
    if (options.editor?.getGrammar?.() === lumine.grammars.nullGrammar) return;
    let suggestionsPromise;
    this.suggestionRequest?.close();
    this.activeSuggestionDetail?.controller.abort();
    this.suggestionAbortController?.abort();
    this.suggestionAbortController = null;
    const providers = this.providerManager.applicableProviders(
      this.editorLabels,
      options.scopeDescriptor,
    );
    const candidateTrigger = options.activatedManually ? null : this.triggerCharacter;
    const triggerProviders = candidateTrigger
      ? new Set(
          providers.filter(
            (provider) => provider.triggerCharacters?.has?.(candidateTrigger) === true,
          ),
        )
      : null;
    if (
      candidateTrigger &&
      !triggerProviders?.size &&
      !this.autoActivationEnabled &&
      !this.suggestionList.isActive()
    ) {
      this.currentSuggestionsPromise = null;
      return;
    }
    if (!providers.length) {
      this.currentSuggestionsPromise = null;
      return;
    }
    const captured = options.requestContext ?? this.captureCompletionContext(options.editor);
    if (!this.isCompletionContextCurrent(captured)) return;
    const requestContext = {
      ...captured,
      scopeDescriptor: options.scopeDescriptor,
      isCurrent: () => this.isCompletionContextCurrent(captured),
    };
    const position = Point.fromObject(options.bufferPosition ?? captured.position, true).freeze();
    const controller = new AbortController();
    this.suggestionAbortController = controller;
    const release = () => {
      if (this.suggestionAbortController === controller) this.suggestionAbortController = null;
      if (this.suggestionRequest === request) this.suggestionRequest = null;
    };

    this.suggestionContext = requestContext;

    const results = new Array(providers.length);
    const applicable = new Array(providers.length);
    const failures = [];
    let successful = false;
    let remaining = providers.length;
    let closed = false;
    let published = null;
    let partialScheduled = false;
    const detailRequests = new Set();
    let publication = Promise.resolve();
    let rejectPublication;
    const publicationFailure = new Promise((_resolve, reject) => (rejectPublication = reject));
    const request = {
      close() {
        closed = true;
        if (remaining) controller.abort();
      },
      replace(oldSuggestion, newSuggestion) {
        const state = getCompletionItemContext(oldSuggestion)?.identity;
        if (state?.item !== oldSuggestion) return;
        state.item = newSuggestion;
        for (const group of results) {
          if (!group) continue;
          for (let index = 0; index < group.length; index++)
            if (group[index] === oldSuggestion) group[index] = newSuggestion;
        }
      },
      noteDetails(suggestion) {
        detailRequests.add(getCompletionItemIdentity(suggestion));
      },
      hasDetails(suggestion) {
        return detailRequests.has(getCompletionItemIdentity(suggestion));
      },
    };
    this.suggestionRequest = request;
    const current = () =>
      !closed &&
      !controller.signal.aborted &&
      !this.disposed &&
      !this.compositionInProgress &&
      this.suggestionRequest === request &&
      this.isCompletionContextCurrent(requestContext) &&
      this.currentSuggestionsPromise === suggestionsPromise;
    const publish = (complete) => {
      if (!current()) return;
      const suggestions = this.mergeSuggestionsFromProviders(
        results.filter((_group, index) => applicable[index]?.()),
      );
      if (!complete && (!suggestions.length || !this.shouldDisplaySuggestions)) return;
      if (
        complete &&
        !failures.length &&
        options.activatedManually &&
        this.shouldDisplaySuggestions &&
        this.autoConfirmSingleSuggestionEnabled &&
        !(published !== null && this.suggestionList?.hasExplicitSelection?.()) &&
        suggestions.length === 1
      ) {
        if (!request.hasDetails(suggestions[0])) this.getDetailsOnSelect(suggestions[0]);
        return this.confirm(suggestions[0]);
      }
      if (
        published &&
        published.length === suggestions.length &&
        published.every((suggestion, index) => suggestion === suggestions[index])
      )
        return;
      const preserveSelection = published !== null;
      published = suggestions.slice();
      return this.displaySuggestions(suggestions, {
        ...options,
        preserveSelection,
        isCurrentRequest: current,
      });
    };
    const schedulePartial = () => {
      if (partialScheduled) return;
      partialScheduled = true;
      publication = publication.then(() => {
        partialScheduled = false;
        // Synchronous providers settle together. Publish their final list once.
        if (remaining) return publish(false);
      });
      void publication.catch(rejectPublication);
    };

    const providerPromises = [];
    providers.forEach((provider, providerIndex) => {
      if (closed || this.suggestionRequest !== request) return;
      const registration = this.providerManager.metadataForProvider?.(provider);
      const providerController = new AbortController();
      const signal = AbortSignal.any([
        controller.signal,
        providerController.signal,
        ...(registration ? [registration.signal] : []),
      ]);
      const sourceIds = new WeakMap(),
        explicitIds = new Map();
      const isApplicable = () => !registration?.signal.aborted && provider.enabled !== false;
      applicable[providerIndex] = isApplicable;
      const providerTrigger = triggerProviders?.has(provider) ? candidateTrigger : null;
      const context = {
        provider,
        requestContext,
        prefix: options.prefix,
        isApplicable,
        registrationSignal: registration?.signal,
      };
      let settled = false;
      let publicationIndex = 0;
      const accept = (providerSuggestions) => {
        if (providerSuggestions == null) return;
        if (!Array.isArray(providerSuggestions))
          throw new TypeError("Completion providers must return an array of suggestions");
        const update = ++publicationIndex;
        const suggestions = [];
        for (const source of providerSuggestions) {
          if (!source || typeof source !== "object") continue;
          const id = source.id;
          const hasId = typeof id === "string" || typeof id === "number";
          let state = hasId ? explicitIds.get(id) : sourceIds.get(source);
          if (!state) {
            state = { acceptedSource: null, item: null, lastSeen: 0 };
            if (hasId) explicitIds.set(id, state);
            else sourceIds.set(source, state);
          }
          if (state.lastSeen === update) continue;
          state.lastSeen = update;
          if (state.acceptedSource !== source) {
            const item = normalizeItem(source, context, state);
            if (!item) continue;
            state.acceptedSource = source;
            state.item = item;
          }
          suggestions.push(state.item);
        }
        results[providerIndex] = provider.filterSuggestions
          ? this.filterSuggestions(suggestions, options)
          : suggestions;
      };
      const fail = (error) => {
        if (!current() || signal.aborted) return;
        failures.push(error);
        providerController.abort();
        if (results[providerIndex] != null) successful = true;
      };
      const publishSuggestions = (suggestions) => {
        // Providers can publish during their synchronous dispatch.
        queueMicrotask(() => {
          if (settled || signal.aborted || !isApplicable() || !current()) return;
          try {
            accept(suggestions);
            schedulePartial();
          } catch (error) {
            fail(error);
          }
        });
      };
      const { editor, prefix, scopeDescriptor, activatedManually } = options;

      let providerResult;
      try {
        if (!signal.aborted)
          providerResult = provider.getSuggestions({
            editor,
            bufferPosition: position,
            prefix,
            scopeDescriptor,
            activatedManually,
            signal,
            publishSuggestions,
            triggerKind: providerTrigger ? TRIGGER_CHARACTER : TRIGGER_INVOKED,
            triggerCharacter: providerTrigger,
          });
      } catch (error) {
        providerResult = Promise.reject(error);
      }
      providerPromises.push(
        untilAborted(providerResult, signal)
          .then((providerSuggestions) => {
            settled = true;
            if (!current() || signal.aborted || !isApplicable()) return;
            accept(providerSuggestions);
            successful = true;
          })
          .catch((error) => {
            settled = true;
            fail(error);
          })
          .finally(() => {
            if (!isApplicable()) results[providerIndex] = undefined;
            remaining--;
            if (current()) schedulePartial();
          }),
      );
    });

    if (!providerPromises || !providerPromises.length) {
      release();
      return;
    }

    suggestionsPromise = Promise.all(providerPromises);
    // A provider may synchronously dispatch a newer completion request. Do
    // not overwrite that request's identity when this older setup returns.
    if (!closed && this.suggestionRequest === request)
      this.currentSuggestionsPromise = suggestionsPromise;
    else request.close();
    const completion = suggestionsPromise.then(() => {
      if (current() && failures.length) {
        if (!successful)
          throw failures.length === 1
            ? failures[0]
            : new AggregateError(failures, "Completion providers failed");
        for (const error of failures) console.error("Unable to read completion provider", error);
      }
      publication = publication.then(() => publish(true));
      return publication;
    });
    return Promise.race([completion, publicationFailure]).then(
      (result) => {
        // A settled request has no more work to cancel on the next keypress.
        // Keep the controller until asynchronous popup publication finishes.
        release();
        return result;
      },
      (error) => {
        const cancelled =
          closed ||
          controller.signal.aborted ||
          this.currentSuggestionsPromise !== suggestionsPromise;
        if (!cancelled && published) this.hideSuggestionList?.();
        controller.abort();
        closed = true;
        release();
        if (cancelled) return;
        throw error;
      },
    );
  }

  filterSuggestions(suggestions, { prefix }) {
    const results = [];

    // Legacy behavior: filtering used to include a "sanity check" that ensured
    // the first character of the suggestion matched the first character of the
    // input.
    //
    // The original intent of this decision is not known, but it aged poorly,
    // especially as autocompletion suggestions got more sophisticated and grew
    // the ability to trigger arbitrary text edits instead of just adding
    // characters to what had been typed.
    //
    // We envision this will eventually go away altogether, but as an
    // intermediate step, we've turned it into an option that is `false` by
    // default.
    let firstCharacterMustMatch = lumine.config.get("autocomplete.firstCharacterMustMatch");

    // One prepared query per replacement prefix. The view reads the same
    // match's lazy character indices.
    const queries = new Map();
    for (let i = 0; i < suggestions.length; i++) {
      const suggestion = suggestions[i];
      const suggestionPrefix = suggestion.replacementPrefix ?? prefix;
      const prefixIsEmpty = !suggestionPrefix || suggestionPrefix === " ";

      // Nothing typed yet, so nothing to rank by: keep the provider's order.
      // `ranges` replaces arbitrary spans of the buffer, so the typed prefix
      // says nothing about whether the suggestion applies. A `textEdit` is
      // different — it replaces the word being typed, so the prefix is exactly
      // the right thing to filter on, and exempting it (as this used to) meant
      // an LSP list was never filtered at all.
      let match;
      if (!prefixIsEmpty && (!suggestion.ranges || suggestion.textEdit)) {
        let query = queries.get(suggestionPrefix);
        if (!query) {
          query = queryFor(this, suggestionPrefix);
          queries.set(suggestionPrefix, query);
        }
        match = matchSuggestion(suggestion, suggestionPrefix, query);
        if (!match || (firstCharacterMustMatch && !match.firstCharacterMatches)) continue;
      }
      results.push({
        suggestion,
        sortText: suggestion.sortText,
        sortIndex: i,
        score: match?.score ?? 0,
        matchTier: match ? matchTierFor(match) : MATCH_SUBSEQUENCE,
      });
    }

    results.sort(compareSuggestions);
    return results.map(({ suggestion }) => suggestion);
  }

  mergeSuggestionsFromProviders(providerSuggestions) {
    return providerSuggestions.reduce((suggestions, providerSuggestions) => {
      if (providerSuggestions && providerSuggestions.length) {
        suggestions = suggestions.concat(providerSuggestions);
      }

      return suggestions;
    }, []);
  }

  displaySuggestions(suggestions, options) {
    const selected =
      options.preserveSelection && this.suggestionList?.hasExplicitSelection?.()
        ? this.suggestionList.getSelectedItem()
        : null;
    switch (lumine.config.get("autocomplete.similarSuggestionRemoval")) {
      case "textOrSnippet": {
        suggestions = this.removeRedundantSuggestions(suggestions, selected);
        break;
      }
    }

    if (this.shouldDisplaySuggestions && suggestions.length) {
      return this.showSuggestionList(suggestions, options);
    } else {
      return this.hideSuggestionList();
    }
  }

  removeRedundantSuggestions(suggestions, selected = null) {
    const firstByText = new Map();
    const duplicatesByText = new Map();
    const builtinProvider = this.providerManager?.defaultProvider;
    const selectedIdentity = getCompletionItemIdentity(selected);
    let result = null;
    for (let index = 0; index < suggestions.length; index++) {
      const suggestion = suggestions[index];
      const text = suggestion.text ?? suggestion.snippet ?? suggestion.textEdit?.newText;
      const first = firstByText.get(text);
      if (!first) firstByText.set(text, suggestion);
      else {
        // Most candidates have distinct text. Allocate the semantic index
        // only when the first text collision actually needs it.
        let group = duplicatesByText.get(text);
        if (!group) {
          group = { words: new Set(), effects: new Map() };
          addDistinctSuggestion(group, first, builtinProvider, selectedIdentity);
          duplicatesByText.set(text, group);
        }
        if (!addDistinctSuggestion(group, suggestion, builtinProvider, selectedIdentity)) {
          result ??= suggestions.slice(0, index);
          continue;
        }
      }
      result?.push(suggestion);
    }
    return result ?? suggestions;
  }

  getPrefix(editor, position, scopeDescriptor) {
    const wordCharacterRegex = this.getWordCharacterRegex(scopeDescriptor);
    const start = Math.max(0, position.column - MAX_PREFIX_LENGTH - 1);
    const line = editor.getBuffer().getTextInRange([[position.row, start], position]);

    let startColumn = line.length;
    while (startColumn > 0) {
      let prevChar = line[startColumn - 1];
      if (wordCharacterRegex.test(prevChar)) {
        startColumn--;
      } else {
        break;
      }
    }
    // Never hand a provider the tail of an oversized identifier as though it
    // were the complete replacement prefix.
    return line.length - startColumn > MAX_PREFIX_LENGTH ? "" : line.slice(startColumn);
  }

  getWordCharacterRegex(scopeDescriptor) {
    const additionalWordChars = getAdditionalWordCharacters(scopeDescriptor);
    let regex = wordCharacterRegexCache.get(additionalWordChars);

    if (!regex) {
      const { UnicodeLetters } = require("./unicode-helpers");
      const escapedWordChars = additionalWordChars.replace(/[-\\^$*+?.()|[\]{}]/g, "\\$&");
      regex = new RegExp(`[${UnicodeLetters}${escapedWordChars}\\d]`);
      wordCharacterRegexCache.set(additionalWordChars, regex);
    }
    return regex;
  }

  confirm(suggestion) {
    return this.insertSuggestion(suggestion, this.editor?.getLastCursor()?.getBufferPosition());
  }

  insertSuggestion(suggestion, triggerPosition, commit = null) {
    const editor = this.editor;
    if (!suggestion || !editor || editor.isDestroyed() || editor.isReadOnly() || this.disposed)
      return false;
    if (this.confirmation && !this.confirmation.controller.signal.aborted) return false;

    const item = getCompletionItemContext(suggestion);
    const context = this.captureCompletionContext(editor);
    if (!this.isCompletionContextCurrent(context)) return false;
    if (
      item &&
      (!item.isApplicable() ||
        (commit?.previousRevision != null &&
          item.requestContext.revision !== commit.previousRevision) ||
        !this.isCompletionContextCurrent(
          item.requestContext,
          commit ? { revision: context.revision, allowCursorMovement: true } : undefined,
        ))
    )
      return false;

    const controller = new AbortController();
    const confirmation = (this.confirmation = { controller });
    const detail =
      this.activeSuggestionDetail?.item === suggestion ? this.activeSuggestionDetail : null;
    const isCurrent = () =>
      !controller.signal.aborted &&
      this.confirmation === confirmation &&
      this.isCompletionContextCurrent(context) &&
      item?.isApplicable() !== false;
    const release = () => {
      if (this.confirmation !== confirmation) return;
      this.confirmation = null;
      controller.abort();
      detail?.controller.abort();
    };
    const finish = (changed, resolved) => {
      release();
      if (!changed) return false;
      if (commit && this.editor === editor) this.refreshAfterCommitCharacter(commit.character);
      const resolvedItem = getCompletionItemContext(resolved);
      if (
        resolved.provider?.onDidInsertSuggestion &&
        !editor.isDestroyed() &&
        resolvedItem?.isApplicable() !== false
      ) {
        const notification = resolved.provider.onDidInsertSuggestion({
          editor,
          suggestion: resolved,
          triggerPosition,
        });
        if (notification?.then) return notification.then(() => true);
      }
      return true;
    };
    const apply = (resolved) => {
      if (!isCurrent()) return false;
      const result = this.replaceTextWithMatch(resolved, {
        commit,
        signal: controller.signal,
        isCurrent,
        scope: item?.requestContext,
      });
      return result?.then
        ? result.then((changed) => finish(changed, resolved))
        : finish(result, resolved);
    };

    try {
      const pending = this.pendingDetails.get(suggestion);
      this.hideSuggestionList();
      const result = pending
        ? this.awaitDetails(suggestion, pending, controller.signal).then(apply)
        : apply(suggestion);
      if (result?.then) return result.finally(release);
      release();
      return result;
    } catch (error) {
      release();
      throw error;
    }
  }

  awaitDetails(suggestion, pending, signal) {
    let timer;
    let cancel;
    const deadline = new Promise((resolve) => {
      cancel = () => resolve(suggestion);
      if (signal?.aborted) return cancel();
      signal?.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(cancel, DETAILS_TIMEOUT_MS);
    });
    return Promise.race([pending, deadline])
      .then((result) => result || suggestion)
      .finally(() => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      });
  }

  getDetailsOnSelect(suggestion) {
    if (
      !this.disposed &&
      this.editor &&
      !this.editor.isDestroyed() &&
      suggestion != null &&
      suggestion.provider &&
      suggestion.provider.getSuggestionDetailsOnSelect
    ) {
      const itemContext = getCompletionItemContext(suggestion);
      if (itemContext && !itemContext.isApplicable()) return;
      const editor = this.editor;
      const generation = this.suggestionGeneration;
      const syntaxIsCurrent = captureSyntaxConfiguration(editor);
      const request = this.suggestionRequest;
      if (
        this.activeSuggestionDetail?.item === suggestion &&
        !this.activeSuggestionDetail.controller.signal.aborted
      )
        return this.pendingDetails.get(suggestion);
      this.activeSuggestionDetail?.controller.abort();
      const controller = new AbortController();
      const active = (this.activeSuggestionDetail = { controller, item: suggestion });
      const signal = itemContext?.registrationSignal
        ? AbortSignal.any([controller.signal, itemContext.registrationSignal])
        : controller.signal;
      request?.noteDetails(suggestion);
      let result;
      try {
        result = suggestion.provider.getSuggestionDetailsOnSelect(
          itemContext?.source ?? suggestion,
          { signal },
        );
      } catch (error) {
        result = Promise.reject(error);
      }
      const ownsDetails = () =>
        !signal.aborted &&
        !this.disposed &&
        this.editor === editor &&
        this.suggestionGeneration === generation &&
        syntaxIsCurrent() &&
        itemContext?.isApplicable() !== false;
      const ownsList = () =>
        !itemContext || this.isCompletionContextCurrent(itemContext.requestContext);
      const finishWithoutUpdate = () => {
        if (ownsDetails() && ownsList()) this.suggestionList.noteDetailsSettled(suggestion);
        return suggestion;
      };
      const pending = untilAborted(result, signal)
        .then((detailedSuggestion) => {
          if (detailedSuggestion == null || detailedSuggestion === itemContext?.source)
            return finishWithoutUpdate();
          if (!ownsDetails()) return suggestion;
          const resolved = itemContext
            ? normalizeItem(detailedSuggestion, itemContext, itemContext.identity, suggestion)
            : { ...suggestion, ...detailedSuggestion, provider: suggestion.provider };
          if (!resolved) return finishWithoutUpdate();
          // A commit character may be waiting for this result. Return it to
          // the guarded confirmation, but only update a still-current list.
          if (ownsList()) {
            request?.replace(suggestion, resolved);
            this.suggestionList.replaceItem(suggestion, resolved);
          }
          return resolved;
        })
        // A provider failing to resolve detail must not prevent insertion.
        .catch(finishWithoutUpdate)
        .finally(() => {
          if (this.activeSuggestionDetail === active) this.activeSuggestionDetail = null;
        });
      this.pendingDetails.set(suggestion, pending);
      return pending;
    }
  }

  replaceTextWithMatch(
    suggestion,
    { commit, signal, isCurrent = () => true, scope, selectPrimaryEdit } = {},
  ) {
    const editor = this.editor;
    if (!editor || editor.isReadOnly() || !isCurrent()) return false;
    const plan = createCompletionEditPlan(editor, suggestion, {
      commit,
      signal,
      selectPrimaryEdit,
      prepareSnippet: this.snippetsManager?.prepareSnippet?.bind(this.snippetsManager),
      wordSeparators:
        this.consumeSuffix &&
        ((position) =>
          lumine.config.get("editor.nonWordCharacters", {
            scope:
              scope?.position?.isEqual(position) && scope.scopeDescriptor
                ? scope.scopeDescriptor
                : editor.scopeDescriptorForBufferPosition(position),
          })),
    });
    if (!plan) return false;
    const withCommit = (callback) => {
      const previous = this.applyingCompletionEdit;
      this.applyingCompletionEdit = true;
      try {
        return callback();
      } finally {
        this.applyingCompletionEdit = previous;
      }
    };
    const apply = (prepared) => {
      if (!isCurrent() || (plan.prepare && !prepared?.isCurrent())) return false;
      const edit = (target) => applyCompletionEditPlan(target, plan, prepared);
      if (plan.indent) {
        return editor.transactWithAutoIndentation(edit, {
          signal,
          isCurrent,
          withCommit,
          prepareDraftIndentation: plan.prepareDraftIndentation,
        });
      }
      return withCommit(() => {
        const changed = editor.transact(0, () => edit(editor));
        if (changed) editor.getLastSelection()?.autoscroll();
        return changed;
      });
    };
    const prepared = plan.prepare ? plan.prepare() : null;
    return prepared?.then ? prepared.then(apply) : apply(prepared);
  }

  isCurrentFileBlackListed() {
    // Glob matching is slow. Not necessary to do this computation on every request for suggestions
    let left;
    if (this.isCurrentFileBlackListedCache != null) {
      return this.isCurrentFileBlackListedCache;
    }

    if (this.fileBlacklist == null || this.fileBlacklist.length === 0) {
      this.isCurrentFileBlackListedCache = false;
      return this.isCurrentFileBlackListedCache;
    }

    if (picomatch == null) {
      picomatch = require("picomatch");
    }
    const fileName = path.basename((left = this.buffer.getPath()) != null ? left : "");
    for (let i = 0; i < this.fileBlacklist.length; i++) {
      const blacklistGlob = this.fileBlacklist[i];
      if (picomatch.isMatch(fileName, blacklistGlob)) {
        this.isCurrentFileBlackListedCache = true;
        return this.isCurrentFileBlackListedCache;
      }
    }

    this.isCurrentFileBlackListedCache = false;
    return this.isCurrentFileBlackListedCache;
  }

  isTriggerCharacter(character) {
    if (!character || this.providerManager == null || this.editor == null) return false;
    if (this.editor.getBuffer().getLanguageMode().asynchronousSyntax)
      return this.providerManager.hasTriggerCharacter(this.editorLabels, character);
    const cursor = this.editor.getLastCursor();
    if (cursor == null) return false;
    const providers = this.providerManager.applicableProviders(
      this.editorLabels,
      cursor.getScopeDescriptor(),
    );
    // `?.has?.()` rather than `.has()`: the contract asks for a `Set`, and a
    // provider that hands over something else must not break every keystroke.
    return providers.some((provider) => provider.triggerCharacters?.has?.(character) === true);
  }

  suggestionForCommitCharacter(character) {
    if (!character) return null;
    if (!lumine.config.get("autocomplete.commitCharacters")) return null;
    if (!this.suggestionList || !this.suggestionList.isActive()) return null;
    const suggestion = this.suggestionList.getSelectedItem();
    const characters = suggestion && suggestion.commitCharacters;
    if (!characters || !characters.includes(character)) return null;
    return suggestion;
  }

  async confirmWithCommitCharacter(suggestion, character, range, { previousRevision } = {}) {
    const commit = { range: Range.fromObject(range), previousRevision, character };
    return this.insertSuggestion(suggestion, commit.range.start, commit);
  }
}
module.exports = CompletionRuntime.prototype;
