const { CompositeDisposable } = require("lumine");
const { matchSuggestion, matchTextFor, queryFor } = require("./completion-matches");
const ProviderConfig = require("./provider-config");
const getAdditionalWordCharacters = require("./get-additional-word-characters");
const TYPE_LOOKUP_BUDGET_MS = 8;

module.exports = class SubsequenceProvider {
  constructor(options = {}) {
    this.defaults();

    this.subscriptions = new CompositeDisposable();
    this.watchedBuffers = new Map();
    this.documentBuffers = new Set();
    this.bufferSubscriptions = new Map();

    if (options.lumineConfig) {
      this.lumineConfig = options.lumineConfig;
    }

    if (options.lumineTextEditors) {
      this.lumineTextEditors = options.lumineTextEditors;
    }

    this.providerConfig = new ProviderConfig({
      lumineConfig: this.lumineConfig,
    });

    // make this.X available where X is the autocomplete.X setting
    const settings = [
      "autocomplete.enableExtendedUnicodeSupport", // TODO
      "autocomplete.minimumWordLength",
      "autocomplete.includeCompletionsFromAllBuffers",
      "autocomplete.useLocalityBonus",
      "autocomplete.strictMatching",
    ];
    settings.forEach((property) => {
      this.subscriptions.add(
        this.lumineConfig.observe(property, (val) => {
          this[property.split(".")[1]] = val;
        }),
      );
    });

    // Watch every registered editor — pane items and the editors packages
    // register (notebook cells, panel inputs) alike — so their buffers can
    // serve as completion sources.
    this.subscriptions.add(
      this.lumineTextEditors.observe((e) => {
        this.watchBuffer(e);
      }),
      this.lumineTextEditors.onDidRemoveEditor((e) => {
        this.unwatchBuffer(e);
      }),
    );
  }

  inspect() {
    return `SubsequenceProvider {apiVersion: ${this.apiVersion}}`;
  }

  defaults() {
    this.lumineConfig = lumine.config;
    this.lumineTextEditors = lumine.textEditors;

    this.possibleWordCharacters = "/\\()\"':,.;<>~!@#$%^&*|+=[]{}`?_-…".split("");
    this.enableExtendedUnicodeSupport = false;
    this.maxSuggestions = 20;
    this.maxResultsPerBuffer = 20;
    this.maxSearchRowDelta = 3000;

    this.labels = ["workspace-center", "default", "subsequence-provider"];
    this.scopeSelector = "*";
    this.inclusionPriority = 0;
    this.suggestionPriority = 0;

    this.watchedBuffers = null;
    this.documentBuffers = null;
  }

  dispose() {
    this.disposed = true;
    this.subscriptions.dispose();
    this.watchedBuffers.clear();
    this.documentBuffers.clear();
    this.bufferSubscriptions.clear();
  }

  watchBuffer(editor) {
    // Only document content participates in the source pool. Inputs and
    // viewers may host completion UI, but their text must not leak into other
    // editors' suggestions.
    const role = this.lumineTextEditors.roleFor(editor);
    if (role !== "document" && role !== "fragment") return;
    const buffer = editor.getBuffer();

    if (!this.watchedBuffers.has(buffer)) {
      const bufferSubscriptions = new CompositeDisposable();
      this.bufferSubscriptions.set(buffer, bufferSubscriptions);
      this.subscriptions.add(bufferSubscriptions);
      bufferSubscriptions.add(
        buffer.onDidDestroy(() => {
          bufferSubscriptions.dispose();
          this.subscriptions.remove(bufferSubscriptions);
          this.bufferSubscriptions.delete(buffer);
          this.watchedBuffers.delete(buffer);
          this.documentBuffers.delete(buffer);
        }),
      );
    }

    this.watchedBuffers.set(buffer, editor);
    // Editors registered as documents are self-contained: they complete from
    // their own buffer. Fragments (notebook cells, watch expressions) and
    // unregistered editors complete from the whole pool instead.
    if (this.lumineTextEditors.roleFor(editor) === "document") {
      this.documentBuffers.add(buffer);
    }
  }

  unwatchBuffer(editor) {
    const buffer = editor.getBuffer();
    if (this.watchedBuffers.get(buffer) !== editor) {
      return;
    }
    // Another registered editor may still expose this buffer (split panes);
    // keep the buffer as a source through it.
    const replacement = this.lumineTextEditors
      .getEditors()
      .find(
        (other) =>
          other !== editor &&
          ["document", "fragment"].includes(this.lumineTextEditors.roleFor(other)) &&
          other.getBuffer() === buffer,
      );
    if (replacement) {
      this.watchedBuffers.set(buffer, replacement);
      if (this.lumineTextEditors.roleFor(replacement) === "document") {
        this.documentBuffers.add(buffer);
      } else {
        this.documentBuffers.delete(buffer);
      }
    } else {
      const subscription = this.bufferSubscriptions.get(buffer);
      subscription?.dispose();
      this.subscriptions.remove(subscription);
      this.bufferSubscriptions.delete(buffer);
      this.watchedBuffers.delete(buffer);
      this.documentBuffers.delete(buffer);
    }
  }

  configSuggestionsToSubsequenceMatches(suggestions, prefix) {
    if (!suggestions || suggestions.length === 0) {
      return Promise.resolve([]);
    }

    const query = queryFor(this, prefix);
    const matches = [];
    for (const suggestion of suggestions) {
      const match = matchSuggestion(suggestion, prefix, query);
      if (match)
        matches.push({
          word: matchTextFor(suggestion),
          score: match.score,
          configSuggestion: suggestion,
        });
    }
    return Promise.resolve(matches.sort(compareMatches).slice(0, this.maxResultsPerBuffer));
  }

  clampedRange(maxDelta, cursorRow, maxRow) {
    const clampedMinRow = Math.max(0, cursorRow - maxDelta);
    const clampedMaxRow = Math.min(maxRow, cursorRow + maxDelta);
    const actualMinRowDelta = cursorRow - clampedMinRow;
    const actualMaxRowDelta = clampedMaxRow - cursorRow;

    return {
      start: {
        row: clampedMinRow - maxDelta + actualMaxRowDelta,
        column: 0,
      },
      end: {
        row: clampedMaxRow + maxDelta - actualMinRowDelta,
        column: 0,
      },
    };
  }

  async bufferToSubsequenceMatches(
    prefix,
    additionalWordCharacters,
    currentEditor,
    buffer,
    signal,
  ) {
    // Non-workspace editors (search fields, watch expressions) aren't tracked
    // in watchedBuffers; their own buffer is searched via the requesting editor.
    const editor =
      this.watchedBuffers.get(buffer) ??
      (buffer === currentEditor.getBuffer() ? currentEditor : null);
    if (!editor || editor.getGrammar?.() === lumine.grammars.nullGrammar) {
      return Promise.resolve([]);
    }
    const position = editor.getCursorBufferPosition();
    const searchRange = this.clampedRange(
      this.maxSearchRowDelta,
      position.row,
      buffer.getEndPosition().row,
    );
    const controller = new AbortController();
    const grammarSubscription = editor.onDidChangeGrammar(() => controller.abort());
    try {
      const matches = await buffer.findWordCandidates(prefix, {
        extraWordCharacters: additionalWordCharacters,
        maxCount: this.maxResultsPerBuffer,
        range: searchRange,
        position:
          buffer === currentEditor.getBuffer()
            ? currentEditor.getCursorBufferPosition()
            : undefined,
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      });
      return controller.signal.aborted ? [] : matches;
    } finally {
      grammarSubscription.dispose();
    }
  }

  /*
  Section: Suggesting Completions
  */

  getSuggestions({ editor, bufferPosition: _bufferPosition, prefix, scopeDescriptor, signal }) {
    if (editor.getGrammar?.() === lumine.grammars.nullGrammar) return;
    if (!prefix || this.disposed || signal?.aborted) {
      return;
    }

    if (prefix.trim().length < this.minimumWordLength) {
      return;
    }

    // Get buffers to search for completions. Only a document editor is
    // self-contained; fragments (notebook cells, watch expressions), inputs
    // (search fields), and unregistered editors hold just a piece of what the
    // user works on, so they complete from all open sources as well.
    const currentEditorBuffer = editor.getBuffer();
    const searchAllBuffers =
      this.includeCompletionsFromAllBuffers || !this.documentBuffers.has(currentEditorBuffer);
    const bufferSet = new Set(searchAllBuffers ? this.watchedBuffers.keys() : []);
    bufferSet.add(currentEditorBuffer);
    const buffers = Array.from(bufferSet);

    const additionalWordCharacters = getAdditionalWordCharacters(scopeDescriptor);

    const configSuggestions = this.providerConfig.getSuggestionsForScopeDescriptor(scopeDescriptor);

    const configMatches = this.configSuggestionsToSubsequenceMatches(configSuggestions, prefix);

    const types = new Map();
    const editorForMatch = (match) =>
      this.watchedBuffers.get(match.buffer) ??
      (match.buffer === currentEditorBuffer ? editor : null);
    const subsequenceMatchToType = (match) => {
      if (types.has(match)) return types.get(match);
      const matchEditor = editorForMatch(match);
      if (!matchEditor) return null;
      if (match.buffer.getLanguageMode().asynchronousSyntax) return "";
      const scopeDescriptor = matchEditor.scopeDescriptorForBufferPosition(match.position);
      return this.providerConfig.scopeDescriptorToType(scopeDescriptor);
    };

    const matchToSuggestion = (match) => {
      return (
        match.configSuggestion || {
          text: match.word,
          type: subsequenceMatchToType(match),
          characterMatchIndices: match.matchIndices,
        }
      );
    };

    const bufferResultsToSuggestions = async (matchesByBuffer) => {
      if (this.disposed || signal?.aborted) return [];
      const relevantMatches = [];
      let matchedWords = new Set();
      let match;

      for (let k = 0; k < matchesByBuffer.length; k++) {
        // The findWordsWithSubsequence method will return `null`
        // if the async work was cancelled due to the buffer being
        // mutated since it was enqueued. We return `null` in this
        // case because `getSuggestions` will be called again anyway.
        if (!matchesByBuffer[k]) return null;

        const buffer = buffers[k];
        for (let l = 0; l < matchesByBuffer[k].length; l++) {
          match = matchesByBuffer[k][l];

          if (match.word === prefix) continue;
          if (matchedWords.has(match.word)) continue;
          if (this.strictMatching && match.word.indexOf(prefix) !== 0) continue;

          let matchIsUnderCursor = false;
          if (buffer === currentEditorBuffer && match.score > 0) {
            matchIsUnderCursor = match.containsPosition;

            if (this.useLocalityBonus) {
              match.score += Math.floor(11 / (1 + 0.04 * match.distance));
            }
          }

          if (matchIsUnderCursor) continue;

          match.buffer = buffer;

          relevantMatches.push(match);
          matchedWords.add(match.word);
        }
      }

      const selected = relevantMatches.sort(compareMatches).slice(0, this.maxSuggestions);
      const batches = new Map();
      for (const match of selected) {
        if (match.configSuggestion) continue;
        const source = editorForMatch(match),
          mode = match.buffer.getLanguageMode();
        if (!source || !mode.asynchronousSyntax || mode.publicationPending || mode.error) continue;
        if (!batches.has(source)) batches.set(source, []);
        batches.get(source).push(match);
      }
      // Types are optional decoration. Never hold word matches behind a cold
      // or busy parser in another buffer; query only selected candidates.
      if (batches.size) {
        const budget = AbortSignal.timeout(TYPE_LOOKUP_BUDGET_MS);
        const lookupSignal = signal ? AbortSignal.any([signal, budget]) : budget;
        await Promise.all(
          [...batches].map(async ([source, matches]) => {
            const scopes = await source.getScopeDescriptorsForBufferPositions(
              matches.map((match) => match.position),
              { signal: lookupSignal },
            );
            if (scopes)
              for (let index = 0; index < matches.length; index++)
                types.set(matches[index], this.providerConfig.scopeDescriptorToType(scopes[index]));
          }),
        );
      }
      if (this.disposed || signal?.aborted) return [];
      return selected.map(matchToSuggestion);
    };

    return Promise.all(
      buffers
        .map((buffer) =>
          this.bufferToSubsequenceMatches(prefix, additionalWordCharacters, editor, buffer, signal),
        )
        .concat(configMatches),
    ).then(bufferResultsToSuggestions);
  }
};

const compareMatches = (a, b) => {
  if (a.score - b.score === 0) {
    return a.word.length - b.word.length;
  }
  return b.score - a.score;
};
