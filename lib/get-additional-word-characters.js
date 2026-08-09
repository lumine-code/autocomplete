const POSSIBLE_WORD_CHARACTERS = "/\\()\"':,.;<>~!@#$%^&*|+=[]{}`?_-…".split("");

module.exports = function getAdditionalWordCharacters(scopeDescriptor) {
  const nonWordCharacters = lumine.config.get("language.nonWordCharacters", {
    scope: scopeDescriptor,
  });
  let result = lumine.config.get("autocomplete.extraWordCharacters", { scope: scopeDescriptor });
  POSSIBLE_WORD_CHARACTERS.forEach((character) => {
    if (!nonWordCharacters.includes(character)) {
      result += character;
    }
  });
  return result;
};
