const { Point, Range, TextBuffer } = require("lumine");

describe("bounded autocomplete input", () => {
  let runtime, Manager;
  beforeEach(() => {
    runtime = require("../lib/completion-runtime");
    Manager = require("../lib/autocomplete-manager");
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
      bracketMatcherPairs: ["()"],
      suggestionForCommitCharacter: () => null,
      autoActivationEnabled: true,
      suggestionList: { isActive: () => false },
      refreshAfterInput: jasmine.createSpy("refreshAfterInput"),
      getPrefix: () => "",
      cancelSuggestions: jasmine.createSpy("cancelAll"),
    };
    expect(() =>
      Manager.prototype.processTextInput.call(context, {
        kind: "insert",
        text: "log",
        changes: [change(huge, huge)],
      }),
    ).not.toThrow();
    expect(context.refreshAfterInput).toHaveBeenCalledWith(null, false);
    expect(() =>
      Manager.prototype.processTextInput.call(context, {
        kind: "delete",
        changes: [change(huge, "")],
      }),
    ).not.toThrow();
    expect(context.cancelSuggestions).toHaveBeenCalled();
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
