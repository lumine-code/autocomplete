const { Range } = require("lumine");

const contexts = new WeakMap();

function copyRange(value) {
  const range = Range.fromObject(value, true);
  if (
    ![range.start.row, range.start.column, range.end.row, range.end.column].every(
      (coordinate) => Number.isSafeInteger(coordinate) && coordinate >= 0,
    )
  ) {
    throw new TypeError("Completion edit coordinates must be nonnegative integers");
  }
  return range.freeze();
}

function copyTextEdit(edit) {
  if (typeof edit.newText !== "string") throw new TypeError("Completion edits require text");
  return Object.freeze({ range: copyRange(edit.range ?? edit.oldRange), newText: edit.newText });
}

function normalizeItem(source, context, identity, previous) {
  if (!source || typeof source !== "object") return null;
  const item = previous ? { ...previous, ...source } : { ...source };
  if (item.textEdit != null) item.textEdit = copyTextEdit(item.textEdit);
  const hasText = typeof item.text === "string" && item.text.length > 0;
  const hasSnippet = typeof item.snippet === "string" && item.snippet.length > 0;
  if (!hasText && !hasSnippet) {
    if (!item.textEdit) return null;
    // A standalone edit needs a display label, including when it deletes text.
    item.displayText ??= item.textEdit.newText || "Delete";
  }
  if (item.ranges != null) item.ranges = Object.freeze(item.ranges.map(copyRange));
  if (item.additionalTextEdits != null) {
    item.additionalTextEdits = Object.freeze(item.additionalTextEdits.map(copyTextEdit));
  }
  if (item.commitCharacters != null)
    item.commitCharacters = Object.freeze([...item.commitCharacters]);
  if (item.characterMatchIndices != null)
    item.characterMatchIndices = Object.freeze([...item.characterMatchIndices]);
  item.replacementPrefix ??= context.prefix;
  item.provider = context.provider;
  contexts.set(item, {
    provider: context.provider,
    requestContext: context.requestContext,
    prefix: context.prefix,
    isApplicable: context.isApplicable,
    registrationSignal: context.registrationSignal,
    identity,
    source,
  });
  return Object.freeze(item);
}

function getCompletionItemContext(item) {
  return contexts.get(item);
}

function getCompletionItemIdentity(item) {
  return getCompletionItemContext(item)?.identity ?? item;
}

module.exports = { normalizeItem, getCompletionItemContext, getCompletionItemIdentity };
