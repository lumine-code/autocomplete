const { Point, Range, TextBuffer } = require("lumine");

describe("bounded autocomplete input", () => {
  let runtime, Manager, changes;
  beforeEach(() => {
    runtime = require("../lib/completion-runtime");
    Manager = require("../lib/autocomplete-manager");
    changes = require("../lib/change-text");
  });

  function change(oldTextSource, newTextSource) {
    return {
      oldTextSource,
      newTextSource,
      newRange: new Range([0, 0], [0, 0]),
      get oldText() {
        throw new Error("materialized old change");
      },
      get newText() {
        throw new Error("materialized new change");
      },
    };
  }

  it("classifies a huge replacement or deletion without reading either source", () => {
    const huge = {
      length: 600_000_000,
      slice() {
        throw new Error("read bulk source");
      },
    };
    const context = {
      editor: {
        getLastCursor: () => ({
          getBufferPosition: () => new Point(0, 0),
          getScopeDescriptor() {},
        }),
      },
      insertedCharacterForChanges: runtime.insertedCharacterForChanges,
      bracketMatcherPairs: ["()"],
      suggestionForCommitCharacter: () => null,
      isTriggerCharacter: () => false,
      autoActivationEnabled: true,
      suggestionList: { isActive: () => false },
      cancelNewSuggestionsRequest: jasmine.createSpy("cancel"),
      hideSuggestionList: jasmine.createSpy("hide"),
      getPrefix: () => "",
      cancelSuggestions: jasmine.createSpy("cancelAll"),
    };
    expect(() =>
      Manager.prototype.processBufferChanges.call(context, [change(huge, huge)]),
    ).not.toThrow();
    expect(context.hideSuggestionList).toHaveBeenCalled();
    expect(() =>
      Manager.prototype.processBufferChanges.call(context, [change(huge, "")]),
    ).not.toThrow();
    expect(runtime.insertedCharacterForChanges.call(context, [change("", huge)])).toBeNull();
    expect(runtime.insertedCharacterForChanges.call(context, [change("", "()")])).toBe("(");
  });

  it("tests indentation from chunks without flattening a change", () => {
    const source = {
      *chunks() {
        yield " \t";
        yield " ";
      },
      length: 3,
    };
    expect(changes.isIndentation(change(source, ""), "oldText")).toBeTrue();
    expect(changes.isIndentation(change("  x", ""), "oldText")).toBeFalse();
  });

  it("reads only bounded prefixes and never substitutes the tail of an oversized word", () => {
    const buffer = new TextBuffer({ text: "x".repeat(100_000) + " word" });
    const editor = { getBuffer: () => buffer };
    const read = spyOn(buffer, "getTextInRange").and.callThrough();
    const context = { getWordCharacterRegex: () => /[a-z]/ };
    try {
      expect(runtime.getPrefix.call(context, editor, new Point(0, 100_005))).toBe("word");
      expect(runtime.getPrefix.call(context, editor, new Point(0, 100_000))).toBe("");
      for (const [range] of read.calls.allArgs())
        expect(range[1].column - range[0][1]).toBeLessThanOrEqual(4097);
    } finally {
      buffer.destroy();
    }
  });
});
