# autocomplete.inline-provider

Supplies a preview and a replacement edit for an inline completion in the editor.

|             |                                                               |
| ----------- | ------------------------------------------------------------- |
| Version     | `1.0.0`                                                       |
| Provided by | `provideInlineCompletion()` returning one provider            |
| Consumed by | `consumeInlineCompletion(provider)` returning a `Disposable`  |
| Owner       | [`autocomplete`](https://github.com/lumine-code/autocomplete) |

## Registration

Declare `autocomplete.inline-provider` in `providedServices` at version `1.0.0`.

## Contract

| Required member                                                         | Description                                                          |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `getInlineCompletions({ editor, bufferPosition, triggerKind, signal })` | Returns an array or promise of inline items for the supplied editor. |

| Optional member                              | Description                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| `priority`                                   | Higher-priority providers are asked first. Defaults to `0`.                    |
| `canProvideInlineCompletions(editor)`        | Synchronous eligibility check. Return `false` for a known unavailable backend. |
| `onDidInvalidateInlineCompletions(callback)` | Notify the consumer when current proposals expire. Returns a disposable.       |

Each item has `text` and may include `range`, `filterText`, `snippet`, `isApplicable()`, and `didAccept()`. Use a single-line replacement range containing the requested position. An omitted range inserts at the caret. The text currently in the range must be a prefix of `filterText` or, when that is omitted, of the proposed text. Set `snippet` to a snippet template to expand on acceptance. `isApplicable()` returns `false` when the backend has retired the item. `didAccept()` runs after the edit is applied and receives no arguments.

## Minimal example

```js
provideInlineCompletion() {
  return {
    async getInlineCompletions({ editor, bufferPosition, signal }) {
      const text = await suggest(editor, bufferPosition, signal);
      return text ? [{ text }] : [];
    },
  };
}
```

## Behavior

`triggerKind` is `automatic` for settled typing or deletion, or `invoked` for an explicit request. The suggestion list has priority while visible. Autocomplete edits the buffer only when a current preview is accepted. Changes to the source, selection, or focused editor retire the request and dismiss the preview.

## Teardown

Observe the request signal and dispose backend subscriptions with the service registration.

## Versioning

`1.0.0` provided, `^1.0.0` consumed.
