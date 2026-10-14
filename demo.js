// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
  dependencies: ["language-javascript", "snippets"],
  viewport: { width: 1100, height: 730 },
  async before() {},
  async prepare(context) {
    const { lumine, state, fixture, open } = context;
    state.editor = await open("editing/signal.js");
    await lumine.project.setPaths([fixture("editing")]);
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption: "Complete a partially typed symbol from the current buffer.",
      timeout: 60000,
      async run(context) {
        const { lumine, state } = context;
        {
          await lumine.window.focus();
          state.editor.moveToBottom();
          state.editor.moveToEndOfLine();
          lumine.views.getView(state.editor).blur();
          lumine.views.getView(state.editor).focus();
          await new Promise((r) => setTimeout(r, 350));
          lumine.commands.dispatch(lumine.views.getView(state.editor), "autocomplete:activate");
        }
      },
      ready() {
        return Boolean(
          document.querySelector(".autocomplete-suggestion-list")?.innerText.includes("smooth"),
        );
      },
    },
  ],
  async cleanup() {},
};
