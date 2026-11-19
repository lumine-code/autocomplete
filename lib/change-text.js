function source(change, name) {
  return change[`${name}Source`] ?? change[name];
}

function inputCharacter(text, pairs) {
  // Automatic suggestions follow an input gesture. Bulk replacements and
  // pastes are not keystrokes, even if trimming them would leave one letter.
  if (text.length > 2) return false;
  text = typeof text === "string" ? text : text.slice(0, text.length);
  return text === " " || text.trim().length === 1 || pairs.includes(text);
}

module.exports = { source, inputCharacter };
