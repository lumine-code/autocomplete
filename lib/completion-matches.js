// Matching belongs to the completion model, not the DOM renderer. Providers may
// reuse and mutate suggestion objects; every cache hit checks its query and text.
const matches = new WeakMap();
const queriesByOwner = new WeakMap();
function queryFor(owner, prefix) {
  let queries = queriesByOwner.get(owner);
  if (!queries) queriesByOwner.set(owner, (queries = new Map()));
  let query = queries.get(prefix);
  if (query) queries.delete(prefix);
  else query = lumine.tools.completionMatcher.createQuery(prefix);
  queries.set(prefix, query);
  if (queries.size > 8) queries.delete(queries.keys().next().value);
  return query;
}
const matchTextFor = (item) =>
  item.filterText || item.displayText || item.text || item.snippet || "";

function matchSuggestion(item, prefix, query = lumine.tools.completionMatcher.createQuery(prefix)) {
  const text = matchTextFor(item);
  let entry = matches.get(item);
  if (entry?.text === text && entry.match === null && query.isRefinementOf(entry.prefix)) {
    entry.prefix = prefix;
    entry.label = entry.highlight = undefined;
    return null;
  }
  if (!entry || entry.prefix !== prefix || entry.text !== text) {
    entry = { prefix, text, match: query.match(text), label: undefined, highlight: undefined };
    matches.set(item, entry);
  }
  if (entry.match === undefined) entry.match = query.match(text);
  return entry.match;
}

function characterMatches(item, label, prefix) {
  if (item.characterMatchIndices != null) return item.characterMatchIndices;
  if (!label || !prefix) return [];
  const cached = matches.get(item);
  if (cached?.prefix === prefix && cached.text === matchTextFor(item) && cached.label === label)
    return cached.highlight;
  const query = lumine.tools.completionMatcher.createQuery(prefix);
  let entry = cached;
  if (!entry || entry.prefix !== prefix || entry.text !== matchTextFor(item)) {
    entry = {
      prefix,
      text: matchTextFor(item),
      match: undefined,
      label: undefined,
      highlight: undefined,
    };
    matches.set(item, entry);
  }
  if (entry.label !== label) {
    entry.label = label;
    // filterText controls eligibility/rank; indices must address the displayed
    // label, including a snippet after its placeholders have been expanded.
    if (label === entry.text && entry.match === undefined) entry.match = query.match(label);
    entry.highlight = (label === entry.text ? entry.match : query.match(label))?.matchIndices ?? [];
  }
  return entry.highlight;
}

module.exports = { matchTextFor, matchSuggestion, characterMatches, queryFor };
