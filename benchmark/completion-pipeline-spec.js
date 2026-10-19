const fs = require("node:fs");
const crypto = require("node:crypto");

describe("Completion pipeline performance", () => {
  it("measures real provider requests through first popup layout", async () => {
    jasmine.useRealClock();
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    const until = async (predicate) => {
      const deadline = performance.now() + 10000;
      while (!predicate()) {
        if (performance.now() > deadline) throw new Error("Completion readiness timed out");
        await tick();
      }
    };
    const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
    lumine.config.set("autocomplete.enableAutoActivation", false);
    lumine.config.set("autocomplete.enableAutoConfirmSingleSuggestion", false);
    const workspace = lumine.workspace.getElement();
    workspace.style.width = "1000px";
    workspace.style.height = "800px";
    jasmine.attachToDOM(workspace);
    const editor = await lumine.workspace.open();
    const element = lumine.views.getView(editor);
    element.focus();
    const pack = await lumine.packages.activatePackage("autocomplete");
    expect(fs.realpathSync(pack.path)).toBe(fs.realpathSync(process.env.COMPLETION_PACKAGE));
    const manager = pack.mainModule.autocompleteManager;
    await until(() => manager?.ready && manager.editor === editor);
    const nativeRank = spyOn(lumine.tools.fuzzyMatcher, "setCandidates").and.callThrough();
    const nativeHighlight = spyOn(lumine.tools.fuzzyMatcher, "match").and.callThrough();
    const results = [];
    for (const scenario of [
      { id: "words-6000", words: true },
      { id: "provider-1000-fresh", count: 1000 },
      { id: "provider-10000-fresh", count: 10000 },
      { id: "provider-1000-changing", count: 1000, changing: true },
      { id: "provider-10000-changing", count: 10000, changing: true },
    ]) {
      lumine.config.set("autocomplete.enableBuiltinProvider", Boolean(scenario.words));
      let generation = 0;
      const lease = scenario.words
        ? null
        : lumine.packages.serviceHub.provide("autocomplete.provider", "1.0.0", {
            scopeSelector: "*",
            inclusionPriority: 10,
            suggestionPriority: 10,
            filterSuggestions: true,
            getSuggestions() {
              return Array.from({ length: scenario.count }, (_, i) => ({
                text: `candidate_word_${scenario.changing ? generation : 0}_${i}`,
              }));
            },
          });
      const times = [],
        frames = [],
        calls = [];
      try {
        for (let sample = -3; sample < 9; sample++) {
          generation++;
          manager.cancelSuggestions();
          editor.setText(
            scenario.words
              ? "banana bandana ban_ana bandaid band bNa\n".repeat(6000) + "bna"
              : "caw",
          );
          editor.moveToBottom();
          editor.moveToEndOfLine();
          await editor.whenGrammarSettled();
          element.component.updateSync();
          nativeRank.calls.reset();
          nativeHighlight.calls.reset();
          const expectedCount = scenario.words ? 5 : scenario.count;
          let itemSubscription;
          const itemsReady = new Promise((resolve) => {
            itemSubscription = manager.suggestionList.onDidChangeItems((items) => {
              if (items?.length === expectedCount) resolve();
            });
          });
          let observer, checkReady, timeout;
          const domReady = new Promise((resolve, reject) => {
            checkReady = () => {
              const first = element.querySelector(".autocomplete li .word");
              if (
                manager.suggestionList.items?.length === expectedCount &&
                first?.textContent === manager.suggestionList.items[0].text &&
                first.querySelector(".character-match")
              )
                resolve();
            };
            observer = new MutationObserver(checkReady);
            observer.observe(element, { subtree: true, childList: true });
            timeout = setTimeout(() => reject(new Error("Popup DOM readiness timed out")), 10000);
          });
          const start = performance.now();
          try {
            lumine.commands.dispatch(element, "autocomplete:activate");
            await Promise.race([itemsReady, domReady]);
            element.component.updateSync();
            checkReady();
            await domReady;
          } finally {
            itemSubscription.dispose();
            observer.disconnect();
            clearTimeout(timeout);
          }
          const complete = performance.now() - start;
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          const presented = performance.now() - start;
          if (sample >= 0) {
            times.push(complete);
            frames.push(presented);
            calls.push({
              rank: nativeRank.calls.count(),
              highlight: nativeHighlight.calls.count(),
            });
          }
          expect(editor.getText().endsWith(scenario.words ? "bna" : "caw")).toBe(true);
        }
      } finally {
        lease?.dispose();
        manager.cancelSuggestions();
      }
      results.push({
        id: scenario.id,
        complete: { median: median(times), samples: times },
        twoFrames: { median: median(frames), samples: frames },
        nativeCalls: calls,
      });
    }
    editor.destroy();
    fs.writeFileSync(
      process.env.COMPLETION_OUTPUT,
      JSON.stringify(
        {
          runtime: process.versions,
          samples: 9,
          warmups: 3,
          driverHash: crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex"),
          results,
        },
        null,
        2,
      ),
    );
  }, 180000);
});
