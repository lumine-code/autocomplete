function source(change, name) {
  return change[`${name}Source`] ?? change[name];
}

function isIndentation(change, name) {
  const text = source(change, name);
  const chunks = typeof text === "string" ? [text] : text.chunks();
  for (const chunk of chunks) if (/[^\t ]/.test(chunk)) return false;
  return true;
}

function inputCharacter(text, pairs) {
  // Automatic suggestions follow an input gesture. Bulk replacements and
  // pastes are not keystrokes, even if trimming them would leave one letter.
  if (text.length > 2) return false;
  text = typeof text === "string" ? text : text.slice(0, text.length);
  return text === " " || text.trim().length === 1 || pairs.includes(text);
}

module.exports = { source, isIndentation, inputCharacter };
