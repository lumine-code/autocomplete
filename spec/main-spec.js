const { conditionPromise, waitForAutocomplete } = require("./spec-helper");
const path = require("path");

describe("Autocomplete", () => {
  let editorView;
  let editor;
  let autocompleteManager;
  let mainModule;

  beforeEach(async () => {
    lumine.workspace.project.setPaths([path.join(__dirname, "fixtures")]);
    jasmine.useRealClock();

    // Set to live completion
    lumine.config.set("autocomplete.enableAutoActivation", true);
    lumine.config.set("autocomplete.fileBlacklist", [".*", "*.md"]);

    let workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);

    editor = await lumine.workspace.open("sample.js");
    await lumine.packages.activatePackage("language-javascript");

    // Activate the package
    mainModule = (await lumine.packages.activatePackage("autocomplete")).mainModule;

    await conditionPromise(
      () => mainModule.autocompleteManager && mainModule.autocompleteManager.ready,
    );

    autocompleteManager = mainModule.autocompleteManager;
    editorView = lumine.views.getView(editor);
  });

  describe("@activate()", () =>
    it("activates autocomplete and initializes AutocompleteManager", () => {
      expect(autocompleteManager).toBeDefined();
      expect(editorView.querySelector(".autocomplete")).not.toExist();
    }));

  describe("@deactivate()", () => {
    it("removes all autocomplete views", async () => {
      // Trigger an autocompletion
      editor.moveToBottom();
      editor.insertText("A");

      await waitForAutocomplete(editor);

      expect(editorView.querySelector(".autocomplete")).toExist();

      // Deactivate the package
      await lumine.packages.deactivatePackage("autocomplete");
      expect(editorView.querySelector(".autocomplete")).not.toExist();
    });
  });
});
