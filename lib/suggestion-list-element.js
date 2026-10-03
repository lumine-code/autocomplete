const { CompositeDisposable } = require("lumine");
const SnippetParser = require("./snippet-parser");
const { isString } = require("./type-helpers");
const EXTERNAL_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

const externalUrl = (value) => {
  try {
    const url = new URL(value);
    return EXTERNAL_URL_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
};

const createSuggestionFrag = () => {
  const frag = document.createDocumentFragment();
  const children = ["icon-container", "left-label", "word-container", "right-label"];
  children.forEach((c) => {
    let el = document.createElement("span");
    el.className = c;
    if (c === "word-container") {
      const content = document.createElement("span");
      content.className = "word-content";
      el.appendChild(content);
      let innerEl = document.createElement("span");
      innerEl.className = "word";
      content.appendChild(innerEl);
      // Sits in the same cell as the word so a signature reads as part of it.
      let detailEl = document.createElement("span");
      detailEl.className = "word-detail";
      content.appendChild(detailEl);
    }
    frag.appendChild(el);
  });
  return frag;
};

const ListTemplate = `<div class="suggestion-list-scroller">
    <ol class="list-group"></ol>
  </div>
  <div class="suggestion-description">
    <span class="suggestion-description-content"></span>
    <a class="suggestion-description-more-link" href="#">More..</a>
  </div>`;

const iconTypeToClass = {
  snippet: "icon-move-right",
  import: "icon-package",
  require: "icon-package",
  module: "icon-package",
  package: "icon-package",
  tag: "icon-code",
  attribute: "icon-tag",
  // The letter badge cannot tell these two apart — a path completion offering
  // both renders a column of "f".
  file: "icon-file",
  folder: "icon-file-directory",
};

const SnippetStart = 1;
const SnippetEnd = 2;
const SnippetStartAndEnd = 3;

// How many deferred rows are rendered per frame. `maxItems` is 200, so a full
// list finishes in a handful of frames while no single one carries the lot.
const EXTRA_ITEM_CHUNK_SIZE = 50;

// Maps a fenced code block's language to a grammar scope. Providers write
// either a bare language id (`python`) or a full scope (`source.python`).
const scopeForFenceName = (fenceName) => {
  if (fenceName) {
    if (fenceName.includes(".") && lumine.grammars.grammarForScopeName(fenceName)) {
      return fenceName;
    }
    const grammar = lumine.grammars.treeSitterGrammarForLanguageString?.(fenceName);
    if (grammar) {
      return grammar.scopeName;
    }
    if (lumine.grammars.grammarForScopeName(`source.${fenceName}`)) {
      return `source.${fenceName}`;
    }
  }
  return "text.plain";
};

module.exports = class SuggestionListElement {
  constructor(model) {
    this.element = document.createElement("autocomplete-suggestion-list");
    // Overwritten by the config observer below once a model is attached; the
    // default matters for the element built without one.
    this.maxItems = 200;
    this.emptySnippetGroupRegex = /(\$\{\d+:\})|(\$\{\d+\})|(\$\d+)/gi;
    this.slashesInSnippetRegex = /\\\\/g;
    this.nodePool = null;
    this.extraItems = null;
    this.extraItemsIndex = 0;
    this.extraItemsFrame = null;
    this.subscriptions = new CompositeDisposable();
    this.element.classList.add("popover-list", "select-list", "autocomplete-suggestion-list");
    this.registerMouseHandling();
    this.snippetParser = new SnippetParser();
    this.nodePool = [];
    this.element.innerHTML = ListTemplate;
    this.ol = this.element.querySelector(".list-group");
    this.scroller = this.element.querySelector(".suggestion-list-scroller");
    this.scroller.addEventListener("scroll", this.onScroll.bind(this));
    this.descriptionContainer = this.element.querySelector(".suggestion-description");
    this.descriptionContent = this.element.querySelector(".suggestion-description-content");
    this.descriptionMoreLink = this.element.querySelector(".suggestion-description-more-link");
    this.descriptionGeneration = 0;

    this.model = model;
    if (this.model == null) {
      return;
    }
    this.subscriptions.add(this.model.onDidChangeItems(this.itemsChanged.bind(this)));
    this.subscriptions.add(this.model.onDidChangeItem(this.itemChanged.bind(this)));
    this.subscriptions.add(this.model.onDidSelectNext(this.moveSelectionDown.bind(this)));
    this.subscriptions.add(this.model.onDidSelectPrevious(this.moveSelectionUp.bind(this)));
    this.subscriptions.add(this.model.onDidSelectPageUp(this.moveSelectionPageUp.bind(this)));
    this.subscriptions.add(this.model.onDidSelectPageDown(this.moveSelectionPageDown.bind(this)));
    this.subscriptions.add(this.model.onDidSelectTop(this.moveSelectionToTop.bind(this)));
    this.subscriptions.add(this.model.onDidSelectBottom(this.moveSelectionToBottom.bind(this)));
    this.subscriptions.add(this.model.onDidConfirmSelection(this.confirmSelection.bind(this)));
    this.subscriptions.add(
      this.model.onDidconfirmSelectionIfNonDefault(this.confirmSelectionIfNonDefault.bind(this)),
    );
    this.subscriptions.add(this.model.onDidDispose(this.dispose.bind(this)));

    this.subscriptions.add(
      lumine.config.observe("autocomplete.suggestionListFollows", (suggestionListFollows) => {
        this.suggestionListFollows = suggestionListFollows;
      }),
    );
    this.subscriptions.add(
      lumine.config.observe("autocomplete.maxVisibleSuggestions", (maxVisibleSuggestions) => {
        this.maxVisibleSuggestions = maxVisibleSuggestions;
      }),
    );
    this.subscriptions.add(
      lumine.config.observe("autocomplete.maxSuggestions", (maxSuggestions) => {
        this.maxItems = maxSuggestions;
      }),
    );
    this.subscriptions.add(
      lumine.config.observe("autocomplete.moveToCancel", (moveToCancel) => {
        this.moveToCancel = moveToCancel;
      }),
    );

    process.nextTick(() => {
      if (!this.hasRendered && !this.disposed) this.render();
    });
  }

  // This should be unnecessary but the events we need to override
  // are handled at a level that can't be blocked by react synthetic
  // events because they are handled at the document
  registerMouseHandling() {
    this.element.onmousewheel = (event) => event.stopPropagation();
    this.element.onmousedown = (event) => {
      // Chromium otherwise enters middle-button autoscroll. In the list a
      // middle click selects a row and leaves confirmation to the left button.
      if (event.button === 1) event.preventDefault();
      if (event.button !== 0 && event.button !== 1) return;
      const item = this.findItem(event);
      if (item && item.dataset && item.dataset.index) {
        event.preventDefault();
        // Go through setSelectedIndex rather than assigning: it is what emits
        // `did-select`, without which the clicked row never has its detail
        // resolved and its auto-import edits are lost. `Number` matters too —
        // dataset values are strings, and a string index makes
        // moveSelectionDown compute "1" + 1 === "11".
        this.setSelectedIndex(Number(item.dataset.index));
        event.stopPropagation();
      }
    };

    this.element.onmouseup = (event) => {
      if (event.button === 1) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.button !== 0) return;
      const item = this.findItem(event);
      if (item && item.dataset && item.dataset.index) {
        event.stopPropagation();
        this.confirmSelection();
      }
    };
  }

  onScroll(_event) {
    lumine.views.updateDocument(() => {
      // Replacing a list resets scrollTop and emits a scroll event too. It
      // must not eagerly render the new tail as if the user had scrolled it.
      if (this.scroller.scrollTop > 0) this.renderExtraItems();
    });
  }

  findItem(event) {
    let item = event.target;
    while (item.tagName !== "LI" && item !== this.element) {
      item = item.parentNode;
    }
    if (item.tagName === "LI") {
      return item;
    }
  }

  updateDescription(item) {
    if (!item) {
      if (this.model && this.model.items) {
        item = this.model.items[this.selectedIndex];
      }
    }
    const markdown = item?.descriptionMarkdown || null;
    const codeBlockRenderer = item?.descriptionCodeBlockRenderer || null;
    const description = markdown ? null : item?.description || null;
    const moreURL = externalUrl(item?.descriptionMoreURL);
    if (
      this.renderedDescription &&
      this.renderedDescription.markdown === markdown &&
      this.renderedDescription.codeBlockRenderer === codeBlockRenderer &&
      this.renderedDescription.description === description &&
      this.renderedDescription.moreURL === moreURL
    ) {
      return;
    }
    if (markdown) {
      this.descriptionContainer.style.display = "block";
      this.renderMarkdownDescription(markdown, codeBlockRenderer);
      this.setDescriptionMoreLink(item);
    } else if (description) {
      this.descriptionContainer.style.display = "block";
      this.clearDescription();
      this.descriptionContent.textContent = description;
      this.setDescriptionMoreLink(item);
    } else {
      this.clearDescription();
      this.descriptionContainer.style.display = "none";
    }
    this.renderedDescription = { markdown, codeBlockRenderer, description, moreURL };
  }

  renderMarkdownDescription(markdown, codeBlockRenderer) {
    const html = lumine.tools.markdown.render(markdown, {
      // A docstring opening with `---` is a rule, not YAML front matter.
      handleFrontMatter: false,
      // Documentation comes from the provider; its links are already correct.
      transformLegacyLinks: false,
    });
    const fragment = lumine.tools.markdown.convertToDOM(html);
    const blocks = [...fragment.querySelectorAll("pre")];
    // "fragment" is the mode that runs synchronously and leaves the editors
    // embedded, which is what a detached node can carry.
    if (blocks.length && typeof codeBlockRenderer !== "function") {
      lumine.tools.markdown.applySyntaxHighlighting(fragment, {
        renderMode: "fragment",
        syntaxScopeNameFunc: scopeForFenceName,
      });
    }
    this.clearDescription();
    this.descriptionContent.classList.add("markdown-description");
    this.descriptionContent.appendChild(fragment);
    if (typeof codeBlockRenderer === "function") {
      const generation = this.descriptionGeneration;
      for (const block of blocks) {
        void this.renderDescriptionCodeBlock(block, codeBlockRenderer, generation);
      }
    }
  }

  async renderDescriptionCodeBlock(block, renderer, generation) {
    const code = block.firstElementChild;
    const language = code?.className.replace(/^language-/, "");
    let replacement;
    try {
      replacement = await renderer({
        text: (code ?? block).textContent.replace(/\r?\n$/, ""),
        language,
        scopeName: scopeForFenceName(language),
      });
    } catch {
      // A provider that cannot render this block leaves it to the grammar.
    }
    // Selection, resolve, and dismissal can replace the description while the
    // provider is parsing. A stale result must not restore the previous item.
    if (
      this.disposed ||
      generation !== this.descriptionGeneration ||
      !this.descriptionContent.contains(block)
    )
      return;
    if (replacement) {
      block.replaceWith(replacement);
    } else {
      const placeholder = document.createComment("description code block");
      block.replaceWith(placeholder);
      const fragment = document.createDocumentFragment();
      fragment.appendChild(block);
      const highlighting = lumine.tools.markdown.applySyntaxHighlighting(fragment, {
        renderMode: "fragment",
        syntaxScopeNameFunc: scopeForFenceName,
      });
      placeholder.replaceWith(fragment);
      // Fragment rendering inserts its editor synchronously; grammar loading
      // completes separately and must not produce an unhandled rejection.
      void Promise.resolve(highlighting).catch(() => {});
    }
    lumine.views.pollAfterNextUpdate?.();
  }

  // Code blocks are rendered as live editors, so the previous description has
  // to be torn down rather than just overwritten.
  clearDescription() {
    this.descriptionGeneration++;
    for (const editorElement of this.descriptionContent.querySelectorAll("lumine-text-editor")) {
      editorElement.getModel().destroy();
    }
    this.descriptionContent.classList.remove("markdown-description");
    this.descriptionContent.replaceChildren();
    this.renderedDescription = null;
  }

  setDescriptionMoreLink(item) {
    const descriptionMoreURL = externalUrl(item.descriptionMoreURL);
    if (descriptionMoreURL != null) {
      this.descriptionMoreLink.style.display = "inline";
      this.descriptionMoreLink.setAttribute("href", descriptionMoreURL);
    } else {
      this.descriptionMoreLink.style.display = "none";
      this.descriptionMoreLink.setAttribute("href", "#");
    }
  }

  itemChanged({ suggestion, index }) {
    lumine.views.updateDocument(this.renderItem.bind(this, suggestion, index));
    lumine.views.updateDocument(this.updateDescription.bind(this));
  }

  itemsChanged() {
    if (this.model && this.model.items && this.model.items.length) {
      return this.render();
    } else {
      this.cancelExtraItems();
      this.clearDescription();
      this.descriptionContainer.style.display = "none";
      return lumine.views.updateDocument(this.returnItemsToPool.bind(this, 0));
    }
  }

  render() {
    if (this.disposed) return;
    this.hasRendered = true;
    this.nonDefaultIndex = false;
    // A provider may nominate the entry to start on — an LSP server's
    // `preselect`. It stays the "default" selection, so confirm-if-non-default
    // still treats it as untouched by the user.
    const preselected = this.visibleItems()?.findIndex((item) => item && item.preselect);
    this.selectedIndex = preselected > 0 ? preselected : 0;
    this.model.select(this.getSelectedItem());
    if (lumine.views.pollAfterNextUpdate) {
      lumine.views.pollAfterNextUpdate();
    }

    lumine.views.updateDocument(this.renderItems.bind(this));
    lumine.views.readDocument(this.readUIPropsFromDOM.bind(this));
  }

  moveSelectionUp() {
    if (this.selectedIndex > 0) {
      return this.setSelectedIndex(this.selectedIndex - 1);
    } else if (this.moveToCancel) {
      this.model.activeEditor.moveUp(1);
      return this.model.cancel();
    } else {
      return this.setSelectedIndex(this.visibleItems().length - 1);
    }
  }

  moveSelectionDown() {
    if (this.selectedIndex < this.visibleItems().length - 1) {
      return this.setSelectedIndex(this.selectedIndex + 1);
    } else if (this.moveToCancel) {
      this.model.activeEditor.moveDown(1);
      return this.model.cancel();
    } else {
      return this.setSelectedIndex(0);
    }
  }

  moveSelectionPageUp() {
    const newIndex = Math.max(0, this.selectedIndex - this.maxVisibleSuggestions);

    if (this.moveToCancel) {
      const lines = this.model.activeEditor.getScreenLineCount();
      this.model.activeEditor.moveUp(lines);
      return this.model.cancel();
    } else if (this.selectedIndex !== newIndex) {
      return this.setSelectedIndex(newIndex);
    }
  }

  moveSelectionPageDown() {
    const itemsLength = this.visibleItems().length;
    const newIndex = Math.min(itemsLength - 1, this.selectedIndex + this.maxVisibleSuggestions);

    if (this.moveToCancel) {
      const lines = this.model.activeEditor.getScreenLineCount();
      this.model.activeEditor.moveDown(lines);
      return this.model.cancel();
    } else if (this.selectedIndex !== newIndex) {
      return this.setSelectedIndex(newIndex);
    }
  }

  moveSelectionToTop() {
    const newIndex = 0;

    if (this.moveToCancel) {
      this.model.activeEditor.moveToTop();
      return this.model.cancel();
    } else if (this.selectedIndex !== newIndex) {
      return this.setSelectedIndex(newIndex);
    }
  }

  moveSelectionToBottom() {
    const newIndex = this.visibleItems().length - 1;

    if (this.moveToCancel) {
      this.model.activeEditor.moveToBottom();
      return this.model.cancel();
    } else if (this.selectedIndex !== newIndex) {
      return this.setSelectedIndex(newIndex);
    }
  }

  setSelectedIndex(index) {
    this.nonDefaultIndex = true;
    this.selectedIndex = index;

    this.model.select(this.getSelectedItem());

    // `renderItems` stops after `maxVisibleSuggestions + 1` rows, so index
    // `maxVisibleSuggestions + 1` is the first one that does not exist yet.
    // With a strict `>` it stayed unrendered and the highlight vanished.
    if (index >= this.maxVisibleSuggestions + 1) {
      lumine.views.updateDocument(this.renderExtraItems.bind(this));
    }

    return lumine.views.updateDocument(this.renderSelectedItem.bind(this));
  }

  visibleItems() {
    if (this.model && this.model.items) {
      return this.model.items.slice(0, this.maxItems);
    }
  }

  // Private: Get the currently selected item
  //
  // Returns the selected {Object}
  // Reads the same capped list every `moveSelection*` is bounded by. Indexing
  // the model's full list agreed with it only because the selection could
  // never exceed the cap — an assumption nothing enforced.
  getSelectedItem() {
    const items = this.visibleItems();
    if (items) {
      return items[this.selectedIndex];
    }
  }

  // Private: Confirms the currently selected item or cancels the list view
  // if no item has been selected
  confirmSelection() {
    if (!this.model.isActive()) {
      return;
    }
    const item = this.getSelectedItem();
    if (item != null) {
      return this.model.confirm(item);
    } else {
      return this.model.cancel();
    }
  }

  // Private: Confirms the currently selected item only if it is not the default
  // item or cancels the view if none has been selected.
  confirmSelectionIfNonDefault(event) {
    if (!this.model.isActive()) {
      return;
    }
    if (this.nonDefaultIndex) {
      return this.confirmSelection();
    } else {
      this.model.cancel();
      return event.abortKeyBinding();
    }
  }

  renderItems() {
    let left;
    this.sizingRow?.remove();
    this.sizingRow = null;
    this.element.style.width = null;
    this.ol.style.tableLayout = null;
    const items = (left = this.visibleItems()) != null ? left : [];
    const initialCount = Math.min(
      items.length,
      Math.max(this.maxVisibleSuggestions + 1, this.selectedIndex + 1),
    );
    for (let index = 0; index < initialCount; index++) {
      this.renderItem(items[index], index);
      // A row taken from the pool may have been the measured first row of an
      // older list. Its old column widths must not size this list's labels.
      for (const cell of this.ol.childNodes[index].children) cell.style.width = null;
    }
    // Old deferred rows belong to the previous list and must not affect this
    // list's first measurement or appear at its previous scroll position.
    this.returnItemsToPool(initialCount);
    this.scroller.scrollTop = 0;

    // Defer the rendering of suggestions that are not initially visible
    this.cancelExtraItems();
    if (items.length > initialCount) {
      this.extraItems = items.slice(initialCount);
      this.extraItemsIndex = initialCount;
      this.renderSizingRow(items);
    }

    // Show only the selected documentation. Rendering another item's longest
    // description for measurement exposes a temporary layout and code editor.
    this.updateDescription();
  }

  // Measure the capped list's columns without rendering its deferred rows or
  // their highlights. A collapsed row contributes widths but no visible row
  // or height; it is removed as soon as the measurements have been read.
  renderSizingRow(items) {
    const row = (this.sizingRow = document.createElement("li"));
    row.className = "sizing-row";
    row.setAttribute("aria-hidden", "true");
    const cells = ["icon-container", "left-label", "word-container", "right-label"].map(
      (className) => {
        const cell = document.createElement("span");
        cell.className = className;
        row.appendChild(cell);
        return cell;
      },
    );
    if (items.some((item) => item.iconHTML !== false && (item.type || item.iconHTML))) {
      const icon = document.createElement("i");
      icon.className = "icon";
      const letter = document.createElement("span");
      letter.className = "icon-letter";
      letter.textContent = "v";
      icon.appendChild(letter);
      cells[0].appendChild(icon);
    }
    for (const item of items) {
      for (const [column, text, html] of [
        [1, item.leftLabel, item.leftLabelHTML],
        [3, item.rightLabel, item.rightLabelHTML],
      ]) {
        if (!text && !html) continue;
        const label = document.createElement("span");
        label.className = "sizing-label";
        if (html != null) label.innerHTML = html;
        else label.textContent = text;
        cells[column].appendChild(label);
      }
      const content = document.createElement("span");
      content.className = "word-content sizing-word";
      const word = document.createElement("span");
      word.className = "word";
      word.appendChild(
        this.getDisplayFragment(item.text, item.snippet, item.displayText, null, []),
      );
      content.appendChild(word);
      const detail = document.createElement("span");
      detail.className = "word-detail";
      detail.textContent = item.displayTextDetail ?? "";
      content.appendChild(detail);
      cells[2].appendChild(content);
    }
    this.ol.appendChild(row);
  }

  // The tail of the list, rendered a chunk at a time. Building all of it in
  // one pass is up to `maxItems` DOM writes in the frame the user scrolled,
  // and the list is scrolled while they are still typing into it. The rest is
  // handed to the next frame — `lumine.views.updateDocument` alone would not do,
  // since writes queued during a document update are drained in the same one.
  renderExtraItems() {
    if (!this.extraItems) {
      return;
    }

    // Never stop short of the selected row: `renderSelectedItem` runs straight
    // after this when a jump caused it, and needs the node to exist to move the
    // highlight onto it.
    const count = Math.max(
      EXTRA_ITEM_CHUNK_SIZE,
      this.selectedIndex - this.extraItemsIndex + 1 || 0,
    );
    const chunk = this.extraItems.splice(0, count);
    for (let index = 0; index < chunk.length; index++) {
      this.renderItem(chunk[index], this.extraItemsIndex + index);
    }
    this.extraItemsIndex += chunk.length;

    if (this.extraItems.length) {
      this.extraItemsFrame = requestAnimationFrame(() => {
        this.extraItemsFrame = null;
        lumine.views.updateDocument(this.renderExtraItems.bind(this));
      });
    } else {
      this.extraItems = null;
    }
  }

  // Drops the pending tail. A frame left in flight would otherwise render the
  // previous list's items into the new one.
  cancelExtraItems() {
    if (this.extraItemsFrame != null) {
      cancelAnimationFrame(this.extraItemsFrame);
      this.extraItemsFrame = null;
    }
    this.extraItems = null;
  }

  returnItemsToPool(pivotIndex) {
    if (!this.ol) {
      return;
    }

    let li = this.ol.childNodes[pivotIndex];
    while (this.ol != null && li) {
      li.remove();
      if (li === this.sizingRow) this.sizingRow = null;
      else this.nodePool.push(li);
      li = this.ol.childNodes[pivotIndex];
    }
  }

  renderSelectedItem() {
    const selectedLi = this.ol.childNodes[this.selectedIndex];
    if (this.selectedLi !== selectedLi && this.selectedLi?.classList) {
      this.selectedLi.classList.remove("selected");
    }

    this.selectedLi = selectedLi;
    if (this.selectedLi != null) {
      this.selectedLi.classList.add("selected");
      this.scrollSelectedItemIntoView();
      return this.updateDescription();
    }
  }

  // This is reading the DOM in the updateDOM cycle. If we dont, there is a flicker :/
  scrollSelectedItemIntoView() {
    const { scrollTop } = this.scroller;
    const selectedItemTop = this.selectedLi.offsetTop;
    if (selectedItemTop < scrollTop) {
      // scroll up
      this.scroller.scrollTop = selectedItemTop;
      return;
    }

    const { itemHeight } = this.uiProps;
    const scrollerHeight = this.maxVisibleSuggestions * itemHeight + this.uiProps.paddingHeight;
    if (selectedItemTop + itemHeight > scrollTop + scrollerHeight) {
      // scroll down
      this.scroller.scrollTop = selectedItemTop - scrollerHeight + itemHeight;
    }
  }

  readUIPropsFromDOM() {
    if (!this.uiProps) {
      this.uiProps = {};
    }
    this.uiProps.width = Math.ceil(this.element.getBoundingClientRect().width);
    this.uiProps.columnWidths = Array.from(
      this.ol.firstChild?.children || [],
      (cell) => cell.getBoundingClientRect().width,
    );
    this.sizingRow?.remove();
    this.sizingRow = null;
    this.uiProps.marginLeft = 0;
    if (!this.uiProps.itemHeight && this.selectedLi) {
      this.uiProps.itemHeight = this.selectedLi.offsetHeight;
    }
    if (!this.uiProps.paddingHeight) {
      this.uiProps.paddingHeight =
        parseInt(getComputedStyle(this.element)["padding-top"]) +
        parseInt(getComputedStyle(this.element)["padding-bottom"]);
      if (!this.uiProps.paddingHeight) {
        this.uiProps.paddingHeight = 0;
      }
    }

    // Update UI during this read, so that when polling the document the latest
    // changes can be picked up.
    return this.updateUIForChangedProps();
  }

  updateUIForChangedProps() {
    this.scroller.style["max-height"] =
      `${this.maxVisibleSuggestions * this.uiProps.itemHeight + this.uiProps.paddingHeight}px`;
    this.element.style.width = `${this.uiProps.width}px`;
    // Fix the measured columns as well as the outer box. Deferred rows can
    // contain longer labels; adding them must not move the visible word column.
    this.ol.style.tableLayout = "fixed";
    const totalWidth = this.uiProps.columnWidths.reduce((sum, width) => sum + width, 0);
    const iconWidth = this.uiProps.columnWidths[0] || 0;
    const textWidth = totalWidth - iconWidth;
    const scale = textWidth
      ? Math.min(1, Math.max(0, this.scroller.clientWidth - iconWidth) / textWidth)
      : 1;
    Array.from(this.ol.firstChild?.children || []).forEach((cell, index) => {
      cell.style.boxSizing = "border-box";
      cell.style.width = `${this.uiProps.columnWidths[index] * (index === 0 ? 1 : scale)}px`;
    });
    if (this.suggestionListFollows === "Word") {
      // The fixed table may distribute rounding space differently from its
      // natural layout. Align against the final column, before it is painted.
      this.uiProps.marginLeft = -(
        this.selectedLi?.querySelector(".word-container").offsetLeft || 0
      );
      this.element.style["margin-left"] = `${this.uiProps.marginLeft}px`;
    } else {
      this.element.style.marginLeft = null;
    }
    return this.renderSelectedItem();
  }

  // Splits the classes on spaces so as not to anger the DOM gods
  addClassToElement(element, classNames) {
    if (!classNames) {
      return;
    }
    const classes = classNames.split(" ");
    if (classes) {
      for (let i = 0; i < classes.length; i++) {
        let className = classes[i];
        className = className.trim();
        if (className) {
          element.classList.add(className);
        }
      }
    }
  }

  renderItem(
    {
      iconHTML,
      type,
      snippet,
      text,
      displayText,
      displayTextDetail,
      className,
      replacementPrefix,
      leftLabel,
      leftLabelHTML,
      rightLabel,
      rightLabelHTML,
      characterMatchIndices,
    },
    index,
  ) {
    let li = this.ol.childNodes[index];
    if (li === this.sizingRow) li = null;
    if (!li) {
      if (this.nodePool && this.nodePool.length > 0) {
        li = this.nodePool.pop();
      } else {
        li = document.createElement("li");
        li.appendChild(createSuggestionFrag());
      }
      li.dataset.index = index;
      this.ol.insertBefore(li, this.sizingRow || null);
    }

    li.className = "";
    if (index === this.selectedIndex) {
      li.classList.add("selected");
    }
    if (className) {
      this.addClassToElement(li, className);
    }
    if (index === this.selectedIndex) {
      this.selectedLi = li;
    }

    // Keep the table cell: replacing row zero's cell loses its measured width
    // and redistributes the columns when asynchronous details arrive.
    const iconContainer = li.querySelector(".icon-container");
    iconContainer.replaceChildren();

    const sanitizedType = isString(type) ? type : "";
    const sanitizedIconHTML = isString(iconHTML) ? iconHTML : undefined;
    if ((sanitizedIconHTML || sanitizedType) && iconHTML !== false) {
      let icon = document.createElement("i");
      icon.className = "icon";

      if (sanitizedIconHTML != null) {
        icon.innerHTML = sanitizedIconHTML;
      } else {
        let defaultIcon;

        // `hasOwn`, not a truthiness check: a suggestion of type
        // "constructor" would otherwise resolve through Object.prototype and
        // set the class name to the source of the Object function.
        if (Object.hasOwn(iconTypeToClass, sanitizedType)) {
          defaultIcon = document.createElement("i");
          defaultIcon.className = iconTypeToClass[sanitizedType];
        } else if (sanitizedType) {
          defaultIcon = document.createElement("span");
          defaultIcon.className = "icon-letter";
          defaultIcon.textContent = sanitizedType[0];
        }

        if (defaultIcon) {
          icon.appendChild(defaultIcon);
        }
      }

      if (type) {
        this.addClassToElement(icon, type);
      }

      iconContainer.appendChild(icon);
    }

    const wordSpan = document.createElement("span");
    wordSpan.className = "word";
    wordSpan.appendChild(
      this.getDisplayFragment(text, snippet, displayText, replacementPrefix, characterMatchIndices),
    );
    li.querySelector(".word").replaceWith(wordSpan);

    // Never HTML: a signature is full of angle brackets, and there is no
    // `displayTextDetailHTML` counterpart to opt into markup.
    li.querySelector(".word-detail").textContent =
      displayTextDetail != null ? displayTextDetail : "";

    const leftLabelSpan = li.querySelector(".left-label");
    if (leftLabelHTML != null) {
      leftLabelSpan.innerHTML = leftLabelHTML;
    } else if (leftLabel != null) {
      leftLabelSpan.textContent = leftLabel;
    } else {
      leftLabelSpan.textContent = "";
    }

    const rightLabelSpan = li.querySelector(".right-label");
    if (rightLabelHTML != null) {
      rightLabelSpan.innerHTML = rightLabelHTML;
    } else if (rightLabel != null) {
      rightLabelSpan.textContent = rightLabel;
    } else {
      rightLabelSpan.textContent = "";
    }
  }

  getDisplayFragment(text, snippet, displayText, replacementPrefix, characterMatchIndices) {
    let replacementText = text;
    let snippetIndices;
    if (typeof displayText === "string") {
      replacementText = displayText;
    } else if (typeof snippet === "string") {
      replacementText = this.removeEmptySnippets(snippet);
      const snippets = this.snippetParser.findSnippets(replacementText);
      replacementText = this.removeSnippetsFromText(snippets, replacementText);
      snippetIndices = this.findSnippetIndices(snippets);
    }

    if (!characterMatchIndices) {
      characterMatchIndices = this.findCharacterMatchIndices(replacementText, replacementPrefix);
    }
    characterMatchIndices = new Set(characterMatchIndices);

    const appendNonMatchChars = (el, nonMatchChars) => {
      if (nonMatchChars) {
        el.appendChild(document.createTextNode(nonMatchChars));
      }
    };

    let frag = document.createDocumentFragment();
    let workingEl = frag;
    var nonMatchChars = "";
    for (let index = 0; index < replacementText.length; index++) {
      if (
        snippetIndices &&
        (snippetIndices[index] === SnippetStart || snippetIndices[index] === SnippetStartAndEnd)
      ) {
        appendNonMatchChars(workingEl, nonMatchChars);
        nonMatchChars = "";

        let s = document.createElement("span");
        s.className = "snippet-completion";
        workingEl = s;
      }

      if (characterMatchIndices && characterMatchIndices.has(index)) {
        appendNonMatchChars(workingEl, nonMatchChars);
        nonMatchChars = "";

        let s = document.createElement("span");
        s.className = "character-match";
        s.textContent = replacementText[index];
        workingEl.appendChild(s);
      } else {
        nonMatchChars += replacementText[index];
      }

      if (
        snippetIndices &&
        (snippetIndices[index] === SnippetEnd || snippetIndices[index] === SnippetStartAndEnd)
      ) {
        appendNonMatchChars(workingEl, nonMatchChars);
        nonMatchChars = "";

        frag.appendChild(workingEl);
        workingEl = frag;
      }
    }

    appendNonMatchChars(workingEl, nonMatchChars);

    return frag;
  }

  removeEmptySnippets(text) {
    if (!text || !text.length || text.indexOf("$") === -1) {
      return text;
    } // No snippets
    return text.replace(this.emptySnippetGroupRegex, ""); // Remove all occurrences of $0 or ${0} or ${0:}
  }

  // Will convert 'abc(${1:d}, ${2:e})f' => 'abc(d, e)f'
  //
  // * `snippets` {Array} from `SnippetParser.findSnippets`
  // * `text` {String} to remove snippets from
  //
  // Returns {String}
  removeSnippetsFromText(snippets, text) {
    if (!text || !text.length || !snippets || !snippets.length) {
      return text;
    }
    let index = 0;
    let result = "";
    for (const { snippetStart, snippetEnd, body } of snippets) {
      result += text.slice(index, snippetStart) + body;
      index = snippetEnd + 1;
    }
    if (index !== text.length) {
      result += text.slice(index, text.length);
    }
    result = result.replace(this.slashesInSnippetRegex, "\\");
    return result;
  }

  // Computes the indices of snippets in the resulting string from
  // `removeSnippetsFromText`.
  //
  // * `snippets` {Array} from `SnippetParser.findSnippets`
  //
  // e.g. A replacement of 'abc(${1:d})e' is replaced to 'abc(d)e' will result in
  //
  // `{4: SnippetStartAndEnd}`
  //
  // Returns {Object} of {index: SnippetStart|End|StartAndEnd}
  findSnippetIndices(snippets) {
    if (!snippets) {
      return;
    }
    const indices = {};
    let offsetAccumulator = 0;
    for (const { snippetStart, snippetEnd, body } of snippets) {
      const bodyLength = body.length;
      const snippetLength = snippetEnd - snippetStart + 1;
      const startIndex = snippetStart - offsetAccumulator;
      const endIndex = startIndex + bodyLength - 1;
      offsetAccumulator += snippetLength - bodyLength;

      if (startIndex === endIndex) {
        indices[startIndex] = SnippetStartAndEnd;
      } else {
        indices[startIndex] = SnippetStart;
        indices[endIndex] = SnippetEnd;
      }
    }

    return indices;
  }

  // Finds the indices of the chars in text that are matched by replacementPrefix
  //
  // e.g. text = 'abcde', replacementPrefix = 'acd' Will result in
  //
  // {0: true, 2: true, 3: true}
  //
  // Returns an {Object}
  findCharacterMatchIndices(text, replacementPrefix) {
    if (!text?.length || !replacementPrefix?.length) {
      return;
    }
    return (
      lumine.tools.fuzzyMatcher.match(text, replacementPrefix, { recordMatchIndexes: true })
        ?.matchIndexes || []
    );
  }

  dispose() {
    this.disposed = true;
    this.cancelExtraItems();
    this.clearDescription();
    this.subscriptions.dispose();
    this.element.remove();
  }
};
