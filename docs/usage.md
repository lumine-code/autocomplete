# Autocomplete guide

The autocomplete package displays possible completions as you type. See the [package README](../README.md) for installation and the command list.

## How it works

A suggestion list appears while you type, after a configurable activation delay. Out of the box, a built-in provider completes words from the current buffer (or from all open buffers, configurable). You can also open the list on demand with `autocomplete:activate`, confirm a suggestion with `autocomplete:confirm`, and dismiss it with `autocomplete:cancel`.

Ready suggestions appear while slower providers are still working. Later results retain their normal priority, but do not change an entry you have explicitly selected; that choice remains visible within the configured suggestion limit. Confirming or dismissing the list prevents a late response from reopening it. Automatic acceptance of a single result after manual activation waits for all providers and does not override a choice made while they were loading.

When an unmodified file changes outside the editor, Lumine reloads its text and closes any existing completion list. The external change does not trigger suggestions or accept an entry through a commit character. Typing afterwards and opening completion manually work as usual.

Behavior — the activation delay, whether to auto-confirm a single suggestion, minimum word length, and more — is configured in the package's settings in **Settings → Packages → autocomplete**.

## Providers

For CSS, SCSS and Less completions, install `autocomplete`, `ide` and `ide-css`. HTML uses `ide-html` with the same completion hub and client; indented `.sass` files use `ide-sass`. The [language-server setup](https://github.com/lumine-code/ide/blob/master/docs/language-servers.md#installation) includes the installation commands.

`autocomplete` also consumes suggestions supplied directly by packages that own each feature:

- **`snippets`** — your [snippets](https://github.com/lumine-code/snippets#readme), offered as completions.
- **`fuzzy-files`** — project file paths, using the same file set and exclusions as its finder.
- **`autocomplete-lumine`** — the editor API, for package and init-script development.

`snippets` is bundled with the editor. Install `fuzzy-files` and `autocomplete-lumine` like any other optional package.

[`spell-check`](https://github.com/lumine-code/linter/blob/master/docs/usage.md#providers) also offers corrections in this list when it is opened manually.

## Matching and ordering

By default, typing narrows the list by subsequence, not just by prefix: `sfn` finds `setFontName`. Prefix matches rank above looser matches, matched characters are highlighted, and a provider's relevance breaks ties. Enable **Use Strict Matching For Built-In Provider** to require the built-in suggestions to start with the typed prefix.

**Maximum Suggestions** limits how many entries the list holds. The scrollbar represents the whole list from the moment it opens, including entries outside the visible rows.

## Accepting an entry

**Keymap For Confirming A Suggestion** controls whether Tab, Enter, both, or neither accepts the highlighted entry.

A provider may nominate characters that accept an entry, such as `(` after a function name; enable **Commit Characters** to use them. Provider trigger characters such as `.` can open the list even when automatic activation is off.

## Documentation and detail

Providers can attach markdown documentation, a signature, a source module, deprecation state, and extra edits such as a required import. These appear with the selected entry when available.

The documentation below the list shows the selected entry's full signature as soon as its language server returns it. This includes type information for entries without a documentation comment.

When you select another entry, the previous documentation stays visible for up to 50 ms while its replacement loads. A ready description replaces it immediately, without briefly closing the panel.

For documentation supplied by `ide-basedpyright`, Python doctest examples beginning with `>>>` use Python syntax highlighting, including `...` continuation lines. The prompts and expected output remain visible and copyable; output is not parsed as Python. Examples supplied by other language servers keep their declared language. This also applies to [hover documentation](https://github.com/lumine-code/ide/blob/master/docs/code-intelligence.md#hover-and-signature-help).

## Snippet expansion

When a snippets service is available, snippet-based suggestions expand into their full body — including tab stops — when confirmed.
