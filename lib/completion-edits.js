const { Range } = require("lumine");

const INSERT_TEXT_MODE_AS_IS = 1;
const INSERT_TEXT_MODE_ADJUST_INDENTATION = 2;

function lineEnd(source, row) {
  if (row + 1 === source.lineCount) return source.length;
  const end = source.lineStart(row + 1) - 1;
  return source.charCodeAt(end - 1) === 13 ? end - 1 : end;
}

function offsetAt(source, point) {
  const offset = source.offsetAt(point);
  if (offset > lineEnd(source, point.row)) {
    throw new RangeError("Completion range extends past the end of a buffer line");
  }
  return offset;
}

function readRange(source, range) {
  return source.slice(offsetAt(source, range.start), offsetAt(source, range.end));
}

function matchingSuffix(source, position, text, wordSeparators) {
  const start = offsetAt(source, position);
  const following = source.slice(
    start,
    Math.min(start + text.length, lineEnd(source, position.row)),
  );
  for (let length = Math.min(text.length, following.length); length > 0; length--) {
    const suffix = text.slice(-length);
    if (!wordSeparators.includes(suffix[0]) && following.startsWith(suffix)) return length;
  }
  return 0;
}

function compareRanges(a, b) {
  return a.start.compare(b.start) || a.end.compare(b.end);
}

function overlap(a, b) {
  return (
    (a.isEmpty() && b.isEmpty() && a.start.isEqual(b.start)) ||
    (a.start.isLessThan(b.end) && b.start.isLessThan(a.end))
  );
}

function explicitTargets(range, positions, primary, source) {
  const targets = [range];
  if (!range.isSingleLine() || !range.containsPoint(positions[primary])) return targets;
  const expected = readRange(source, range);
  const offset = range.start.column - positions[primary].column;
  for (const [index, position] of positions.entries()) {
    if (index === primary) continue;
    const start = position.column + offset;
    const end = start + range.end.column - range.start.column;
    if (start < 0 || source.lineStart(position.row) + end > lineEnd(source, position.row)) continue;
    const candidate = new Range([position.row, start], [position.row, end]);
    if (
      readRange(source, candidate) === expected &&
      targets.every((target) => !overlap(target, candidate))
    ) {
      targets.push(candidate);
    }
  }
  return targets;
}

function createCompletionEditPlan(
  editor,
  suggestion,
  { commit, signal, prepareSnippet, wordSeparators, selectPrimaryEdit },
) {
  const buffer = editor.getBuffer();
  let source = buffer.getTextSnapshot();
  const cursors = editor.getCursors();
  const positions = cursors.map((cursor) => cursor.getBufferPosition());
  const primary = cursors.indexOf(editor.getLastCursor());
  if (primary < 0) return;

  if (commit) {
    const { range } = commit;
    // A commit character belongs to a single typing gesture. Keep its text in
    // the live document until the whole completion is ready to publish.
    if (cursors.length !== 1 || !range.isSingleLine() || !range.containsPoint(positions[primary]))
      return;
    commit = {
      range,
      text: readRange(source, range),
      cursorOffset: positions[primary].column - range.end.column,
    };
    source = source.replace(offsetAt(source, range.start), offsetAt(source, range.end), "");
    positions[primary] = range.start;
  }

  const edits = [];
  const explicit = suggestion.textEdit;
  const usesSnippet = !suggestion.ranges && Boolean(prepareSnippet && suggestion.snippet);
  const text =
    explicit?.newText ??
    (usesSnippet ? suggestion.snippet : (suggestion.text ?? suggestion.snippet));
  if (typeof text !== "string") return;
  const autoIndent =
    editor.shouldAutoIndent() && suggestion.insertTextMode !== INSERT_TEXT_MODE_AS_IS;
  const reindent = suggestion.insertTextMode === INSERT_TEXT_MODE_ADJUST_INDENTATION;
  let indent = false;

  if (explicit) {
    const range = Range.fromObject(explicit.range ?? explicit.oldRange);
    if (usesSnippet) edits.push({ range, text, selection: primary });
    else {
      indent = reindent && /\r?\n/.test(text);
      for (const target of explicitTargets(range, positions, primary, source)) {
        edits.push({
          range: target,
          text,
          indent: indent ? "rows" : null,
          selection: selectPrimaryEdit && target === range ? primary : undefined,
        });
      }
    }
  } else if (suggestion.ranges) {
    for (const target of suggestion.ranges) edits.push({ range: Range.fromObject(target), text });
  } else {
    const prefix = suggestion.replacementPrefix ?? "";
    const indentation = autoIndent
      ? text === "\n" || text === "\r\n"
        ? "newline"
        : /\S/.test(text)
          ? "decrease"
          : null
      : null;
    indent = Boolean(!usesSnippet && indentation);
    for (const [selection, position] of positions.entries()) {
      const start = position.translate([0, -prefix.length]);
      if (start.column < 0 || readRange(source, new Range(start, position)) !== prefix) continue;
      const suffix = wordSeparators
        ? matchingSuffix(source, position, text, wordSeparators(position))
        : 0;
      const range = new Range(start, position.translate([0, suffix]));
      edits.push({ range, text, selection, indent: usesSnippet ? null : indentation });
    }
  }
  if (!edits.length) return;

  const snippetTargets = usesSnippet ? edits.slice() : [];
  for (const extra of suggestion.additionalTextEdits ?? []) {
    if (typeof extra.newText !== "string")
      throw new TypeError("Additional completion edits require text");
    edits.push({ range: Range.fromObject(extra.range ?? extra.oldRange), text: extra.newText });
  }
  edits.sort((a, b) => compareRanges(a.range, b.range));
  for (const [index, edit] of edits.entries()) {
    offsetAt(source, edit.range.start);
    offsetAt(source, edit.range.end);
    if (index && overlap(edits[index - 1].range, edit.range))
      throw new RangeError("Completion edit ranges overlap");
  }

  // Syntax lookup happens in the current document, which still contains the
  // commit character. An end at the original caret uses its leading edge.
  const prepare =
    usesSnippet &&
    (() =>
      prepareSnippet(
        text,
        editor,
        snippetTargets.map(({ selection }) => cursors[selection]),
        {
          signal,
          positions: snippetTargets.map(({ range }) => {
            const position = range.end;
            if (
              !commit ||
              position.row !== commit.range.start.row ||
              position.isLessThanOrEqual(commit.range.start)
            )
              return position;
            return position.translate([0, commit.range.end.column - commit.range.start.column]);
          }),
        },
      ));

  return {
    edits: edits.reverse(),
    commit,
    prepare,
    adjustIndentation: suggestion.insertTextMode !== INSERT_TEXT_MODE_AS_IS,
    indent,
    prepareDraftIndentation: explicit && indent,
  };
}

function applyCompletionEditPlan(editor, plan, prepared) {
  const selections = editor.getSelections();
  const indentMarkers = [];
  try {
    editor.avoidMergingSelections(() => {
      if (plan.commit) editor.setTextInBufferRange(plan.commit.range, "");
      for (const { range, text, selection, indent } of plan.edits) {
        let inserted;
        if (selection != null) {
          const target = selections[selection];
          target.setBufferRange(range, { autoscroll: false });
          if (prepared) {
            if (!prepared.insert(target.cursor, { adjustIndentation: plan.adjustIndentation }))
              editor.abortTransaction();
          } else inserted = target.insertText(text, { autoscroll: false });
        } else inserted = editor.setTextInBufferRange(range, text);
        if (indent)
          indentMarkers.push({
            marker: editor.markBufferRange(inserted, { invalidate: "never", exclusive: true }),
            indent,
          });
      }
      if (plan.commit) {
        const selection = editor.getLastSelection();
        const inserted = selection.insertText(plan.commit.text, { autoscroll: false });
        if (plan.commit.cursorOffset) {
          const position = inserted.end.translate([0, plan.commit.cursorOffset]);
          selection.setBufferRange(new Range(position, position), { autoscroll: false });
        }
      }
      const rows = new Set();
      for (const { marker, indent } of indentMarkers) {
        const range = marker.getBufferRange();
        if (indent === "decrease") editor.autoDecreaseIndentForBufferRow(range.start.row);
        else if (indent === "newline") {
          editor.autoIndentBufferRow(range.end.row, {
            preserveLeadingWhitespace: true,
            skipBlankLines: false,
          });
        } else {
          for (let row = range.start.row + 1; row <= range.end.row; row++) rows.add(row);
        }
      }
      if (rows.size) editor.autoIndentBufferRowsAtRows([...rows]);
    });
    return true;
  } finally {
    for (const { marker } of indentMarkers) marker.destroy();
  }
}

exports.createCompletionEditPlan = createCompletionEditPlan;
exports.applyCompletionEditPlan = applyCompletionEditPlan;
