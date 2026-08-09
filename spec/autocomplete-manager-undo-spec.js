const { conditionPromise, waitForAutocomplete } = require("./spec-helper");
const path = require("path");

describe("Autocomplete Manager", () => {
  let editorView;
  let editor;
  let mainModule;

  beforeEach(() => {
    lumine.workspace.project.setPaths([path.join(__dirname, "fixtures")]);
    // Set to live completion
    lumine.config.set("autocomplete.enableAutoActivation", true);
    lumine.config.set("editor.fontSize", "16");

    let workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);
  });

  describe("Undo a completion", () => {
    beforeEach(async () => {
      jasmine.useRealClock();
      lumine.config.set("autocomplete.enableAutoActivation", true);

      editor = await lumine.workspace.open("sample.js");

      await lumine.packages.activatePackage("language-javascript");

      // Activate the package
      mainModule = (await lumine.packages.activatePackage("autocomplete")).mainModule;

      await conditionPromise(
        () => mainModule.autocompleteManager && mainModule.autocompleteManager.ready,
      );
    });

    it("restores the previous state", async () => {
      // Trigger an autocompletion
      editor.moveToBottom();
      editor.moveToBeginningOfLine();
      editor.insertText("f");

      await waitForAutocomplete(editor);

      // Accept suggestion
      editorView = lumine.views.getView(editor);
      lumine.commands.dispatch(editorView, "autocomplete:confirm");

      expect(editor.getBuffer().getLastLine()).toEqual("function");

      editor.undo();

      expect(editor.getBuffer().getLastLine()).toEqual("f");
    });
  });
});
