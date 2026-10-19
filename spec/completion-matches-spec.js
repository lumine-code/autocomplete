describe("Completion match ownership", () => {
  let matches;
  beforeEach(() => {
    matches = require("../lib/completion-matches");
  });

  it("reuses scoring for label highlights without calling the native matcher", () => {
    spyOn(lumine.tools.fuzzyMatcher, "match").and.throwError("Native rendering match");
    spyOn(lumine.tools.fuzzyMatcher, "setCandidates").and.throwError("Native ranking match");
    const item = { text: "hello" };
    const prepared = matches.matchSuggestion(item, "hlo");
    expect(matches.characterMatches(item, "hello", "hlo")).toBe(prepared.matchIndices);
    expect(matches.characterMatches(item, "hello", "hlo")).toBe(prepared.matchIndices);
  });

  it("invalidates reused suggestions when prefix, filterText or display text changes", () => {
    const item = { text: "hello" };
    expect(matches.characterMatches(item, "hello", "hlo")).toEqual([0, 3, 4]);
    expect(matches.characterMatches(item, "hello", "hl")).toEqual([0, 2]);
    item.filterText = "unrelated";
    expect(matches.matchSuggestion(item, "hl")).toBeNull();
    item.filterText = "hello";
    expect(matches.characterMatches(item, "world", "hl")).toEqual([]);
    expect(matches.characterMatches(item, "hello", "hl")).toEqual([0, 2]);
  });

  it("keeps filterText ranking separate from label highlights and respects provider indices", () => {
    const item = { text: "@@@", filterText: "foo" };
    expect(matches.matchSuggestion(item, "fo")).not.toBeNull();
    expect(matches.characterMatches(item, "@@@", "fo")).toEqual([]);
    item.characterMatchIndices = [2];
    expect(matches.characterMatches(item, "@@@", "fo")).toEqual([2]);
  });

  it("reuses rejected candidates only for a compatible extension and rechecks deletion", () => {
    const item = { text: "hello" };
    expect(matches.matchSuggestion(item, "hz")).toBeNull();
    const extended = lumine.tools.completionMatcher.createQuery("hzo");
    spyOn(extended, "match").and.throwError("Rejected candidate was scored again");
    expect(matches.matchSuggestion(item, "hzo", extended)).toBeNull();
    expect(matches.matchSuggestion(item, "he")).not.toBeNull();
    item.text = "horizon";
    expect(matches.matchSuggestion(item, "hzo")).not.toBeNull();
  });

  it("bounds prepared query ownership and shares matches across fresh suggestion objects", () => {
    const owner = {};
    const first = matches.queryFor(owner, "he");
    const result = matches.matchSuggestion({ text: "hello" }, "he", first);
    expect(matches.matchSuggestion({ text: "hello" }, "he", matches.queryFor(owner, "he"))).toBe(
      result,
    );
    for (let i = 0; i < 9; i++) matches.queryFor(owner, `query${i}`);
    expect(matches.queryFor(owner, "he")).not.toBe(first);
  });

  it("passes cancellation to providers and skips ranking and display of an aborted response", async () => {
    const runtime = require("../lib/completion-runtime");
    let release, signal;
    const pending = new Promise((resolve) => (release = resolve));
    const provider = {
      filterSuggestions: true,
      getSuggestions(options) {
        signal = options.signal;
        return pending;
      },
    };
    const owner = {
      editor: {},
      editorLabels: [],
      providerManager: { applicableProviders: () => [provider] },
      filterSuggestions: jasmine.createSpy("obsolete ranking"),
      displaySuggestions: jasmine.createSpy("obsolete presentation"),
      mergeSuggestionsFromProviders: runtime.mergeSuggestionsFromProviders,
    };
    const result = runtime.getSuggestionsFromProviders.call(owner, {
      editor: owner.editor,
      prefix: "a",
    });
    owner.suggestionAbortController.abort();
    release([{ text: "abc" }]);
    await result;
    expect(signal.aborted).toBe(true);
    expect(owner.filterSuggestions).not.toHaveBeenCalled();
    expect(owner.displaySuggestions).not.toHaveBeenCalled();
  });
});
