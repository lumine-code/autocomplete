function typeText(editor, text, options) {
  return editor.dispatchTextInput({ kind: "insert", text }, () => editor.insertText(text, options));
}

function deleteText(editor, method = "backspace") {
  return editor.dispatchTextInput({ kind: "delete" }, () => editor[method]());
}

module.exports = { typeText, deleteText };
