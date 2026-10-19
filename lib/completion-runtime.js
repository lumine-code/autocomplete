const { Point, Range } = require("lumine");
const path = require("path");
const { matchTextFor, matchSuggestion, queryFor } = require("./completion-matches");
let additionalWordCharacters;
const getAdditionalWordCharacters = (...args) =>
  (additionalWordCharacters ||= require("./get-additional-word-characters"))(...args);

const MAX_LEGACY_PREFIX_LENGTH = 80;
const wordCharacterRegexCache = new Map();

function compareRanges(a, b) {
  let rangeA = Range.fromObject(a);
  let rangeB = Range.fromObject(b);
  return rangeA.compare(rangeB);
}

function sortTextEdits(textEdits) {
  return textEdits.sort((a, b) => compareRanges(a.range ?? a.oldRange, b.range ?? b.oldRange));
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

const describesItselfDistinctly = (suggestion, kept) => {
  const facets = shownFacetsOf(suggestion);
  // Nothing but the insertion itself: a bare word, safe to drop behind a
  // suggestion that inserts the same thing.
  if (!facets.replaceAll("\0", "")) return false;
  return facets !== shownFacetsOf(kept);
};

// LSP `InsertTextMode`: 1 leaves the inserted text exactly as the provider
// wrote it, 2 re-indents it to match the line it lands on.
const INSERT_TEXT_MODE_AS_IS = 1;
const INSERT_TEXT_MODE_ADJUST_INDENTATION = 2;

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
const matchTierFor = (text, prefix) => {
  if (text.toLowerCase() === prefix.toLowerCase()) return MATCH_EXACT_WORD;
  if (text.startsWith(prefix)) return MATCH_EXACT_PREFIX;
  if (text.toLowerCase().startsWith(prefix.toLowerCase())) return MATCH_PREFIX;
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

// Deferred requires
let picomatch = null;

// Methods keep the manager as their receiver; its public functions remain stable forwarding methods.
class CompletionRuntime {
  findSuggestions(activatedManually) {
    if (this.disposed) {
      return;
    }
    if (this.providerManager == null || this.editor == null || this.buffer == null) {
      return;
    }
    if (this.isCurrentFileBlackListed()) {
      return;
    }
    const cursor = this.editor.getLastCursor();
    if (cursor == null) {
      return;
    }

    const bufferPosition = cursor.getBufferPosition();
    const scopeDescriptor = cursor.getScopeDescriptor();
    const prefix = this.getPrefix(this.editor, bufferPosition, scopeDescriptor); // Passed to providers with API version >= 4.0.0
    const legacyPrefix = this.getLegacyPrefix(this.editor, bufferPosition); // Passed to providers with API version < 4.0.0

    return this.getSuggestionsFromProviders({
      editor: this.editor,
      bufferPosition,
      scopeDescriptor,
      prefix,
      legacyPrefix,
      activatedManually,
    });
  }

  getSuggestionsFromProviders(options) {
    let suggestionsPromise;
    this.suggestionAbortController?.abort();
    const controller = new AbortController();
    this.suggestionAbortController = controller;
    const providers = this.providerManager.applicableProviders(
      this.editorLabels,
      options.scopeDescriptor,
    );

    // Asking for the menu by hand is an invocation whatever was typed last.
    const triggerCharacter = options.activatedManually ? null : this.triggerCharacter;

    const providerPromises = [];
    providers.forEach((provider) => {
      const getSuggestions = provider.getSuggestions.bind(provider);
      const upgradedOptions = Object.assign({}, options);
      upgradedOptions.signal = controller.signal;
      delete upgradedOptions.legacyPrefix;
      // Told rather than inferred: a provider used to have to re-read the
      // buffer to work out which of its trigger characters had fired.
      upgradedOptions.triggerKind = triggerCharacter ? TRIGGER_CHARACTER : TRIGGER_INVOKED;
      upgradedOptions.triggerCharacter = triggerCharacter;

      return providerPromises.push(
        Promise.resolve(getSuggestions(upgradedOptions)).then((providerSuggestions) => {
          if (
            controller.signal.aborted ||
            this.disposed ||
            this.currentSuggestionsPromise !== suggestionsPromise
          )
            return;
          if (providerSuggestions == null) {
            return;
          }

          let hasEmpty = false; // Optimization: only create another array when there are empty items
          for (let i = 0; i < providerSuggestions.length; i++) {
            const suggestion = providerSuggestions[i];
            if (!suggestion.snippet && !suggestion.text) {
              hasEmpty = true;
            }
            // Suggestions are mutable and are updated with a new replacement prefix. In order to
            // distinguish between suggestion that had original prefix and assigned one, we use
            // `isPrefixModified` flag. If it is `true`, we reset replacement prefix.
            if (suggestion.replacementPrefix == null || !!suggestion.isPrefixModified) {
              suggestion.replacementPrefix = options.prefix;
              suggestion.isPrefixModified = true;
            }
            suggestion.provider = provider;
          }

          if (hasEmpty) {
            const res = [];
            for (const s of providerSuggestions) {
              if (s.snippet || s.text) {
                res.push(s);
              }
            }
            providerSuggestions = res;
          }

          if (provider.filterSuggestions) {
            providerSuggestions = this.filterSuggestions(providerSuggestions, options);
          }
          return providerSuggestions;
        }),
      );
    });

    if (!providerPromises || !providerPromises.length) {
      return;
    }

    suggestionsPromise = Promise.all(providerPromises);
    this.currentSuggestionsPromise = suggestionsPromise;
    return this.currentSuggestionsPromise
      .then(this.mergeSuggestionsFromProviders)
      .then((suggestions) => {
        if (
          controller.signal.aborted ||
          this.disposed ||
          this.editor !== options.editor ||
          this.currentSuggestionsPromise !== suggestionsPromise
        ) {
          return;
        }
        if (
          options.activatedManually &&
          this.shouldDisplaySuggestions &&
          this.autoConfirmSingleSuggestionEnabled &&
          suggestions.length === 1
        ) {
          // When there is one suggestion in manual mode, just confirm it. The
          // list is never shown, so `did-select` never fires — ask for the
          // detail explicitly or this path silently skips resolution.
          this.getDetailsOnSelect(suggestions[0]);
          return this.confirm(suggestions[0]);
        } else {
          return this.displaySuggestions(suggestions, options);
        }
      });
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

    // One prepared query per replacement prefix. Scores are retained with the
    // suggestion, and the view reads the same match's lazy character indices.
    const groups = new Map();
    for (let i = 0; i < suggestions.length; i++) {
      const suggestion = suggestions[i];
      // Ties fall back to the order the provider supplied them in.
      suggestion.sortIndex = i;
      suggestion.score = 0;
      suggestion.matchTier = MATCH_SUBSEQUENCE;

      const suggestionPrefix =
        suggestion.replacementPrefix != null ? suggestion.replacementPrefix : prefix;
      const prefixIsEmpty = !suggestionPrefix || suggestionPrefix === " ";

      // Nothing typed yet, so nothing to rank by: keep the provider's order.
      // `ranges` replaces arbitrary spans of the buffer, so the typed prefix
      // says nothing about whether the suggestion applies. A `textEdit` is
      // different — it replaces the word being typed, so the prefix is exactly
      // the right thing to filter on, and exempting it (as this used to) meant
      // an LSP list was never filtered at all.
      if (prefixIsEmpty || suggestion.ranges) {
        results.push(suggestion);
        continue;
      }

      const group = groups.get(suggestionPrefix);
      if (group) group.push(suggestion);
      else groups.set(suggestionPrefix, [suggestion]);
    }

    for (const [suggestionPrefix, group] of groups) {
      const query = queryFor(this, suggestionPrefix);
      for (const suggestion of group) {
        const text = matchTextFor(suggestion);
        if (
          firstCharacterMustMatch &&
          text[0]?.toLowerCase() !== suggestionPrefix[0].toLowerCase()
        ) {
          continue;
        }
        const match = matchSuggestion(suggestion, suggestionPrefix, query);
        if (!match) continue;
        suggestion.score = match.score;
        suggestion.matchTier = matchTierFor(text, suggestionPrefix);
        results.push(suggestion);
      }
    }

    results.sort(compareSuggestions);
    return results;
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
    switch (lumine.config.get("autocomplete.similarSuggestionRemoval")) {
      case "textOrSnippet": {
        suggestions = this.removeRedundantSuggestions(suggestions);
        break;
      }
    }

    if (this.shouldDisplaySuggestions && suggestions.length) {
      return this.showSuggestionList(suggestions, options);
    } else {
      return this.hideSuggestionList();
    }
  }

  removeRedundantSuggestions(suggestions) {
    const keptByText = new Map();
    const result = [];
    for (const suggestion of suggestions) {
      const key = `${suggestion.text ?? ""}\0${suggestion.snippet ?? ""}`;
      const kept = keptByText.get(key);
      if (kept && !describesItselfDistinctly(suggestion, kept)) {
        continue;
      }
      if (!kept) {
        keptByText.set(key, suggestion);
      }
      result.push(suggestion);
    }
    return result;
  }

  getPrefix(editor, position, scopeDescriptor) {
    const wordCharacterRegex = this.getWordCharacterRegex(scopeDescriptor);
    const line = editor.getBuffer().getTextInRange([[position.row, 0], position]);

    let startColumn = position.column;
    while (startColumn > 0) {
      let prevChar = line[startColumn - 1];
      if (wordCharacterRegex.test(prevChar)) {
        startColumn--;
      } else {
        break;
      }
    }
    return line.slice(startColumn);
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

  getLegacyPrefix(editor, bufferPosition) {
    const { row, column } = bufferPosition;
    const line = editor.getTextInRange(
      new Range(new Point(row, Math.max(0, column - MAX_LEGACY_PREFIX_LENGTH)), bufferPosition),
    );
    const prefix = this.prefixRegex.exec(line);
    if (!prefix || !prefix[2] || prefix[2].length === MAX_LEGACY_PREFIX_LENGTH) return "";
    return prefix[2];
  }

  confirm(suggestion) {
    if (this.editor == null || suggestion == null || !!this.disposed) {
      return;
    }

    const editor = this.editor;
    const generation = this.suggestionGeneration;
    const bufferGeneration = this.bufferChangeGeneration;
    const triggerPosition = editor.getLastCursor().getBufferPosition();
    const pending = this.pendingDetails.get(suggestion);

    // Stay synchronous unless a provider actually has detail in flight. Most
    // providers implement no `getSuggestionDetailsOnSelect` at all, and
    // deferring their insertion by a microtask changes observable behavior for
    // no benefit.
    if (!pending) {
      return this.insertSuggestion(suggestion, triggerPosition);
    }

    // Wait for the detail *before* hiding the list. `hideSuggestionList`
    // empties the model, after which a late `replaceItem` is dropped on the
    // floor — so resolving afterwards would silently discard the very edits
    // (auto-imports) we are waiting for.
    return this.awaitDetails(suggestion, pending).then((resolved) => {
      if (
        this.disposed ||
        this.editor !== editor ||
        editor.isDestroyed() ||
        this.suggestionGeneration !== generation ||
        this.bufferChangeGeneration !== bufferGeneration ||
        !editor.getLastCursor()?.getBufferPosition().isEqual(triggerPosition)
      ) {
        return;
      }
      this.insertSuggestion(resolved, triggerPosition);
    });
  }

  insertSuggestion(resolved, triggerPosition) {
    if (!this.editor || this.editor.isDestroyed() || this.editor.isReadOnly()) return;
    const selections = this.editor.getSelections();
    if (selections && selections.length) {
      for (const s of selections) {
        if (s && s.clear) {
          s.clear();
        }
      }
    }

    this.hideSuggestionList();

    this.replaceTextWithMatch(resolved);

    if (resolved.provider && resolved.provider.onDidInsertSuggestion) {
      resolved.provider.onDidInsertSuggestion({
        editor: this.editor,
        suggestion: resolved,
        triggerPosition,
      });
    }
  }

  awaitDetails(suggestion, pending) {
    let timer = null;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(suggestion), DETAILS_TIMEOUT_MS);
    });
    return Promise.race([pending, deadline]).then((result) => {
      if (timer) {
        clearTimeout(timer);
      }
      return result || suggestion;
    });
  }

  getDetailsOnSelect(suggestion) {
    if (
      suggestion != null &&
      suggestion.provider &&
      suggestion.provider.getSuggestionDetailsOnSelect
    ) {
      const pending = Promise.resolve(suggestion.provider.getSuggestionDetailsOnSelect(suggestion))
        .then((detailedSuggestion) => {
          if (detailedSuggestion == null) return suggestion;
          detailedSuggestion.provider ??= suggestion.provider;
          this.suggestionList.replaceItem(suggestion, detailedSuggestion);
          return detailedSuggestion;
        })
        // A provider failing to resolve detail must not prevent insertion.
        .catch(() => suggestion);
      this.pendingDetails.set(suggestion, pending);
      return pending;
    }
  }

  applyTextEdit(textEdit, isSnippet = false, insertTextMode = undefined) {
    if (this.editor === null) return;
    let range = Range.fromObject(textEdit.range ?? textEdit.oldRange);
    if (isSnippet && this.snippetsManager) {
      // Snippet expansion drives the cursor through its tab stops, so it only
      // makes sense at one place: the other cursors keep what they had.
      let selection = this.editor.getLastSelection();
      let cursor = selection.cursor;
      selection.setBufferRange(range);
      Promise.resolve(
        this.snippetsManager.insertSnippet(textEdit.newText, this.editor, cursor, {
          adjustIndentation: insertTextMode !== INSERT_TEXT_MODE_AS_IS,
        }),
      ).catch((error) => console.error("Unable to insert completion snippet", error));
    } else {
      for (const editRange of this.textEditRangesForCursors(range)) {
        const inserted = this.editor.setTextInBufferRange(editRange, textEdit.newText);
        // Plain text carries no tab stops, so nothing re-indents it unless
        // asked. Only worth doing for an edit that spans lines.
        if (
          insertTextMode === INSERT_TEXT_MODE_ADJUST_INDENTATION &&
          inserted.start.row !== inserted.end.row
        ) {
          this.editor.autoIndentBufferRows(inserted.start.row + 1, inserted.end.row);
        }
      }
    }
  }

  textEditRangesForCursors(range) {
    const cursors = this.editor.getCursors();
    if (cursors.length < 2) return [range];

    const origin = this.editor.getLastCursor().getBufferPosition();
    // Only cursors on the same row as the edit can be offset this way; a
    // multi-row edit is not a prefix replacement and is left alone.
    if (range.start.row !== origin.row || range.end.row !== origin.row) return [range];

    const before = origin.column - range.start.column;
    const after = range.end.column - origin.column;
    return (
      cursors
        .map((cursor) => cursor.getBufferPosition())
        // Later rows first, so an earlier edit cannot shift a range still to be
        // applied. Cursors sharing a row are handled right-to-left for the same
        // reason.
        .sort((a, b) => b.compare(a))
        .map((position) =>
          Range.fromObject([
            [position.row, Math.max(0, position.column - before)],
            [position.row, position.column + after],
          ]),
        )
    );
  }

  replaceTextWithMatch(suggestion) {
    if (this.editor == null || this.editor.isReadOnly()) {
      return;
    }

    const cursors = this.editor.getCursors();
    if (cursors == null) {
      return;
    }

    return this.editor.transact(() => {
      // Guard against any stray display markers somehow still being on the
      // layer.
      this.markerLayer.clear();

      let additionalTextEditMarkers = null;
      if (suggestion.additionalTextEdits) {
        let textEdits = sortTextEdits(Array.from(suggestion.additionalTextEdits));
        additionalTextEditMarkers = [];

        // We could apply all the `TextEdit`s at once, but we'd have to find a
        // way to express the default insertion strategy (with consideration of
        // prefix) as a `TextEdit`, since `additionalTextEdits` is valid no
        // matter the insertion strategy.
        //
        // So we won't do that; we'll apply the main edit first. But that means
        // we must now guard against their buffer ranges changing after the
        // edit, so we'll track any change in their buffer ranges with display
        // markers.
        for (let textEdit of textEdits) {
          let range = Range.fromObject(textEdit.range ?? textEdit.oldRange);
          let marker = this.markerLayer.markBufferRange(range, { exclusive: true });
          additionalTextEditMarkers.push([marker, textEdit]);
        }
      }

      if (suggestion.textEdit) {
        // Suggestion wants to apply a `TextEdit` in order to insert itself.
        // This occurs instead of the default text insertion strategy. Sort
        // them in buffer order, then apply them in reverse order (so that no
        // buffer position is affected by any other edits).
        //
        // In LSP, the format of the inserted text can be either plain text or
        // snippet; the format is indicated on the suggestion itself. We
        // already have a `snippet` property that we can reuse for this purpose
        // in a way that's rather backward-compatible. If `snippet` is truthy,
        // we'll assume ourselves to be in snippet mode.
        this.applyTextEdit(suggestion.textEdit, !!suggestion.snippet, suggestion.insertTextMode);
      } else if (suggestion.ranges) {
        // Suggestion wants to insert the default text over one or more
        // specific ranges. This occurs instead of the default text insertion
        // strategy. The same text is inserted into each range. Sort the ranges
        // in buffer order, then apply the edits in reverse order (so that
        // no buffer position is affected by any other edits).
        let ranges = Array.from(suggestion.ranges).sort(compareRanges);
        for (let i = ranges.length - 1; i >= 0; i--) {
          const range = Range.fromObject(ranges[i]);
          this.editor.setTextInBufferRange(range, suggestion.text ?? suggestion.snippet);
        }
      } else {
        // Default text insertion strategy: insert the text or snippet,
        // possibly correcting for characters that might already have been
        // typed.
        for (let i = 0; i < cursors.length; i++) {
          const cursor = cursors[i];
          const endPosition = cursor.getBufferPosition();
          const beginningPosition = [
            endPosition.row,
            endPosition.column - suggestion.replacementPrefix.length,
          ];

          if (
            this.editor.getTextInBufferRange([beginningPosition, endPosition]) ===
            suggestion.replacementPrefix
          ) {
            const suffix = this.consumeSuffix
              ? this.getSuffix(this.editor, endPosition, suggestion)
              : "";
            if (suffix.length) {
              cursor.moveRight(suffix.length);
            }
            cursor.selection.selectLeft(suggestion.replacementPrefix.length + suffix.length);

            if (suggestion.snippet != null && this.snippetsManager != null) {
              Promise.resolve(
                this.snippetsManager.insertSnippet(suggestion.snippet, this.editor, cursor),
              ).catch((error) => console.error("Unable to insert completion snippet", error));
            } else {
              cursor.selection.insertText(
                suggestion.text != null ? suggestion.text : suggestion.snippet,
                {
                  autoIndentNewline: this.editor.shouldAutoIndent(),
                  autoDecreaseIndent: this.editor.shouldAutoIndent(),
                },
              );
            }
          }
        }
      }

      // Alongside any of these insertion strategies, a suggestion can specify
      // additional text edits that should be made. These are typically
      // optional.
      //
      // One example might be auto-inserting an import/include statement when a
      // suggestion from a specific library is inserted (and the library is not
      // already included into the buffer).
      //
      // The buffer positions we originally received might be inaccurate now,
      // because we've changed the buffer since we received these suggestions.
      // That's why we marked the buffer ranges before we made this edit.
      if (additionalTextEditMarkers) {
        for (let i = additionalTextEditMarkers.length - 1; i >= 0; i--) {
          let [marker, textEdit] = additionalTextEditMarkers[i];

          // Now that a suggestion can contain any number of arbitrary text
          // edits, there are some basic sanity rules expected from
          // autocompletion providers. As the LSP spec says: "Edits must not
          // overlap (including the same insert position) with the main edit
          // nor with themselves."
          //
          // Hence this could only happen if the provider were behaving
          // incorrectly, but we'll check for it anyway.
          if (!marker.isValid()) continue;

          // Unlike the main text inserted by the suggestion, additional text
          // edits are applied non-interactively. Hence it only makes sense to
          // apply them as plain text at their exact target once, regardless
          // of how many cursors receive the main prefix replacement.
          this.editor.setTextInBufferRange(marker.getBufferRange(), textEdit.newText);
        }
        // We're done with these markers. We only needed them for a moment so
        // we could track any content shifts.
        this.markerLayer.clear();
      }
    });
  }

  getSuffix(editor, bufferPosition, suggestion) {
    // This just chews through the suggestion and tries to match the suggestion
    // substring with the lineText starting at the cursor. There is probably a
    // more efficient way to do this.
    let suffix = suggestion.snippet != null ? suggestion.snippet : suggestion.text;
    const endPosition = [bufferPosition.row, bufferPosition.column + suffix.length];
    const endOfLineText = editor.getTextInBufferRange([bufferPosition, endPosition]);
    // Scoped, like every other read of this setting: what counts as a word
    // character is the language's business, and reading the global value here
    // let the prefix and the suffix disagree about the same character.
    const nonWordCharacters = new Set(
      lumine.config
        .get("editor.nonWordCharacters", {
          scope: editor.scopeDescriptorForBufferPosition(bufferPosition),
        })
        .split(""),
    );
    while (suffix) {
      if (endOfLineText.startsWith(suffix) && !nonWordCharacters.has(suffix[0])) {
        break;
      }
      suffix = suffix.slice(1);
    }
    return suffix;
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

  insertedCharacterForChanges(changes) {
    if (this.compositionInProgress) return null;
    if (changes.length !== 1) return null;
    const { oldText, newText } = changes[0];
    if (oldText.length > 0) return null;
    if (newText.length === 1) return newText;
    if (newText.length === 2 && this.bracketMatcherPairs.includes(newText)) return newText[0];
    return null;
  }

  isTriggerCharacter(character) {
    if (!character || this.providerManager == null || this.editor == null) return false;
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
    const suggestion = this.suggestionList.suggestionListElement.getSelectedItem();
    const characters = suggestion && suggestion.commitCharacters;
    if (!characters || !characters.includes(character)) return null;
    return suggestion;
  }

  async confirmWithCommitCharacter(suggestion, character, range) {
    const editor = this.editor;
    const generation = this.suggestionGeneration;
    const bufferGeneration = this.bufferChangeGeneration;
    const cursorPosition = editor.getLastCursor().getBufferPosition();
    const pending = this.pendingDetails.get(suggestion);
    // Consume this list while its commit waits, so further typing requests a
    // fresh list rather than confirming the same stale suggestion again.
    if (pending) this.hideSuggestionList();
    // Keep the user's character in the buffer while detail is pending. Run,
    // cancellation and later typing must all see the literal source immediately.
    const resolved = pending ? await this.awaitDetails(suggestion, pending) : suggestion;
    if (
      this.disposed ||
      this.editor !== editor ||
      editor.isDestroyed() ||
      this.suggestionGeneration !== generation ||
      this.bufferChangeGeneration !== bufferGeneration ||
      !editor.getLastCursor()?.getBufferPosition().isEqual(cursorPosition)
    ) {
      return;
    }
    const checkpoint = editor.createCheckpoint();
    this.confirmingCommitCharacter = true;
    try {
      editor.setTextInBufferRange(range, "");
      this.insertSuggestion(resolved, editor.getLastCursor().getBufferPosition());
      this.confirmingCommitCharacter = false;
      // Typed outside the guard, so the character lands like any other
      // keystroke: one that is also a trigger character opens the next list.
      if (!this.disposed && this.editor === editor) editor.insertText(character);
    } finally {
      this.confirmingCommitCharacter = false;
      if (!editor.isDestroyed()) editor.groupChangesSinceCheckpoint(checkpoint);
    }
  }
}
module.exports = CompletionRuntime.prototype;
