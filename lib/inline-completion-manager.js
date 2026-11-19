const { Disposable, Range } = require("lumine");

const AUTOMATIC_DELAY_MS = 180;

module.exports = class InlineCompletionManager {
  constructor(manager) {
    this.manager = manager;
    this.providers = new Set();
    this.setting = lumine.config.observe("autocomplete.inlineCompletions", (enabled) => {
      this.enabled = enabled;
      this.cancel();
      lumine.commands.invalidateAvailability();
    });
  }

  register(provider) {
    if (typeof provider?.getInlineCompletions !== "function")
      throw new TypeError("An inline completion provider must implement getInlineCompletions.");
    const registration = { provider };
    const subscription = provider.onDidInvalidateInlineCompletions?.(() => {
      if (this.entry?.provider === provider || !this.entry?.provider) this.cancel();
      lumine.commands.invalidateAvailability();
    });
    registration.subscription = subscription;
    this.providers.add(registration);
    lumine.commands.invalidateAvailability();
    return new Disposable(() => {
      if (!this.providers.delete(registration)) return;
      subscription?.dispose();
      if (
        this.entry?.provider === provider &&
        ![...this.providers].some((entry) => entry.provider === provider)
      )
        this.cancel();
      lumine.commands.invalidateAvailability();
    });
  }

  providersFor(editor) {
    return [...new Set([...this.providers].map(({ provider }) => provider))]
      .filter((provider) => provider.canProvideInlineCompletions?.(editor) !== false)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  canRequest(editor) {
    return (
      this.enabled &&
      this.providers.size > 0 &&
      !!editor &&
      this.manager.watchedEditors.has(editor) &&
      !editor.isDestroyed() &&
      !editor.isMini() &&
      !editor.isReadOnly() &&
      editor.getGrammar() !== lumine.grammars.nullGrammar &&
      editor.getCursors().length === 1 &&
      editor.getLastSelection()?.isEmpty() &&
      this.providersFor(editor).length > 0
    );
  }

  schedule(editor) {
    this.cancel();
    if (!this.canRequest(editor)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.request(editor, "automatic").catch((error) =>
        console.error("Unable to show inline completion", error),
      );
    }, AUTOMATIC_DELAY_MS);
  }

  async request(editor, triggerKind) {
    this.cancel();
    if (
      !this.canRequest(editor) ||
      this.manager.editor !== editor ||
      this.manager.suggestionList.isActive() ||
      this.manager.shouldSuppressActivationForEditorClasses() ||
      this.manager.isCurrentFileBlackListed()
    )
      return false;
    const context = this.manager.captureCompletionContext(editor);
    if (!this.manager.isCompletionContextCurrent(context, { allowSuggestionChanges: true }))
      return false;
    const entry = (this.entry = {
      editor,
      context,
      element: this.manager.editorView,
      controller: new AbortController(),
      index: 0,
    });
    entry.element.classList.add("autocomplete-inline-requesting");
    lumine.commands.invalidateAvailability();
    const { signal } = entry.controller;
    let abort;
    const cancelled = new Promise((resolve) => {
      abort = () => resolve(null);
      signal.addEventListener("abort", abort, { once: true });
    });

    try {
      for (const provider of this.providersFor(editor)) {
        if (!this.isCurrent(entry)) return false;
        entry.provider = provider;
        let items;
        try {
          items = await Promise.race([
            provider.getInlineCompletions({
              editor,
              bufferPosition: context.position,
              triggerKind,
              signal,
            }),
            cancelled,
          ]);
        } catch (error) {
          if (!signal.aborted && error?.name !== "AbortError")
            console.error("Unable to request inline completion", error);
          continue;
        }
        if (!this.isCurrent(entry)) return false;
        if (!Array.isArray(items)) continue;
        const candidates = [];
        for (const item of items) {
          const candidate = this.prepareItem(entry, item);
          if (candidate) candidates.push(candidate);
          if (candidates.length === 20) break;
        }
        if (!candidates.length) continue;
        entry.items = candidates;
        entry.view = new (require("./inline-completion-view"))(editor);
        if (this.show(entry)) return true;
        return false;
      }
      return false;
    } finally {
      signal.removeEventListener("abort", abort);
      if (this.entry === entry) {
        entry.element.classList.remove("autocomplete-inline-requesting");
        if (!entry.view?.isShowing()) this.cancel();
      }
    }
  }

  prepareItem({ editor, context }, item) {
    if (typeof item?.text !== "string") return null;
    try {
      if (item.isApplicable?.() === false) return null;
      const range = item.range
        ? Range.fromObject(item.range)
        : new Range(context.position, context.position);
      if (
        !range.isSingleLine() ||
        !range.containsPoint(context.position) ||
        !range.start.isEqual(editor.clipBufferPosition(range.start)) ||
        !range.end.isEqual(editor.clipBufferPosition(range.end))
      )
        return null;
      const snippet = typeof item.snippet === "string" ? item.snippet : undefined;
      const snippets = this.manager.snippetsManager;
      const text = snippet === undefined ? item.text : snippets?.previewSnippet?.(snippet);
      if (typeof text !== "string" || (snippet !== undefined && !text)) return null;
      const before = editor.getTextInBufferRange(range);
      if (text === before || !(item.filterText || text).startsWith(before)) return null;

      let prefix = 0;
      while (prefix < before.length && before[prefix] === text[prefix]) prefix++;
      if (prefix && /[\uD800-\uDBFF]/.test(before[prefix - 1])) prefix--;
      const position = range.start.translate([0, prefix]);
      return {
        item,
        range,
        snippet,
        preview: {
          position,
          text: text.slice(prefix),
          replacementRange: prefix < before.length ? new Range(position, range.end) : undefined,
        },
      };
    } catch {
      return null;
    }
  }

  show(entry) {
    const { item, preview } = entry.items[entry.index];
    const showing = item.isApplicable?.() !== false && entry.view.show(preview);
    entry.element.classList.toggle("autocomplete-inline-active", Boolean(showing));
    lumine.commands.invalidateAvailability();
    return Boolean(showing);
  }

  isCurrent(entry) {
    return (
      this.enabled &&
      !!entry &&
      this.entry === entry &&
      !entry.controller.signal.aborted &&
      !this.manager.suggestionList.isActive() &&
      this.manager.isCompletionContextCurrent(entry.context, { allowSuggestionChanges: true })
    );
  }

  canAccept(editor) {
    const entry = this.entry;
    return (
      entry?.editor === editor &&
      this.isCurrent(entry) &&
      !!entry.view?.isShowing() &&
      entry.items[entry.index].item.isApplicable?.() !== false
    );
  }

  canCycle(editor) {
    return this.canAccept(editor) && this.entry.items.length > 1;
  }

  cycle(editor) {
    if (!this.canCycle(editor)) return false;
    const entry = this.entry;
    entry.index = (entry.index + 1) % entry.items.length;
    if (this.show(entry)) return true;
    this.cancel();
    return false;
  }

  accept(editor) {
    if (!this.canAccept(editor)) return false;
    const entry = this.entry;
    const { item, range, snippet } = entry.items[entry.index];
    entry.view.destroy();
    entry.view = null;
    entry.element.classList.remove("autocomplete-inline-active");
    lumine.commands.invalidateAvailability();

    const finish = (changed) => {
      if (this.entry === entry) this.cancel();
      if (changed && typeof item.didAccept === "function") {
        Promise.resolve()
          .then(() => item.didAccept())
          .catch((error) => console.error("Unable to run the inline completion command", error));
      }
      return Boolean(changed);
    };
    try {
      const edit = this.manager.replaceTextWithMatch(
        { textEdit: { range, newText: snippet ?? item.text }, snippet, insertTextMode: 1 },
        {
          signal: entry.controller.signal,
          isCurrent: () => this.isCurrent(entry) && item.isApplicable?.() !== false,
          selectPrimaryEdit: true,
        },
      );
      if (!edit?.then) return finish(edit);
      if (this.entry === entry) entry.element.classList.add("autocomplete-inline-requesting");
      return edit.then(finish, (error) => {
        finish(false);
        if (error?.name !== "AbortError") throw error;
        return false;
      });
    } catch (error) {
      finish(false);
      throw error;
    }
  }

  hasRequest(editor) {
    return this.entry?.editor === editor;
  }

  cancel() {
    clearTimeout(this.timer);
    this.timer = null;
    const entry = this.entry;
    if (!entry) return;
    this.entry = null;
    entry.controller.abort();
    entry.view?.destroy();
    entry.element.classList.remove("autocomplete-inline-active", "autocomplete-inline-requesting");
    lumine.commands.invalidateAvailability();
  }

  dispose() {
    this.setting.dispose();
    this.cancel();
    for (const { subscription } of this.providers) subscription?.dispose();
    this.providers.clear();
  }
};
