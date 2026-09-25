const { CompositeDisposable, Disposable } = require("lumine");
const AutocompleteManager = require("./autocomplete-manager");

module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "autocomplete",
      tips: [
        "You can bring up the completion list at any moment with {{ 'autocomplete:activate' | keystroke }}",
      ],
    };
  },

  subscriptions: null,
  autocompleteManager: new AutocompleteManager(),

  // Public: Creates AutocompleteManager instances for all active and future editors (soon, just a single AutocompleteManager)
  activate() {
    this.subscriptions = new CompositeDisposable();
    this.snippetsManagers = [];
    if (!this.autocompleteManager) this.autocompleteManager = new AutocompleteManager();
    this.subscriptions.add(this.autocompleteManager);
    this.autocompleteManager.initialize();
  },

  // Public: Cleans everything up, removes all AutocompleteManager instances
  deactivate() {
    if (this.subscriptions) {
      this.subscriptions.dispose();
    }
    this.subscriptions = null;
    this.autocompleteManager = null;
    this.snippetsManagers = [];
  },

  provideAutocompleteWatchEditor() {
    return this.autocompleteManager.watchEditor.bind(this.autocompleteManager);
  },

  consumeSnippets(snippetsManager) {
    const entry = { snippetsManager };
    this.snippetsManagers ||= [];
    this.snippetsManagers.push(entry);
    this.updateSnippetsManager();
    return new Disposable(() => {
      const index = this.snippetsManagers?.indexOf(entry) ?? -1;
      if (index >= 0) this.snippetsManagers.splice(index, 1);
      this.updateSnippetsManager();
    });
  },

  updateSnippetsManager() {
    this.autocompleteManager?.setSnippetsManager(
      this.snippetsManagers?.at(-1)?.snippetsManager ?? null,
    );
  },

  /*
  Section: Provider API
  */

  consumeAutocomplete(providers) {
    if (!providers) {
      return;
    }
    if (!Array.isArray(providers)) {
      providers = [providers];
    }
    if (providers.length === 0) {
      return;
    }

    const registrations = new CompositeDisposable();
    for (const provider of providers) {
      registrations.add(this.autocompleteManager.providerManager.registerProvider(provider));
    }
    return registrations;
  },
};
