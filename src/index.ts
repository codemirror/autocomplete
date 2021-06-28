import {Prec, Extension, EditorState} from "@codemirror/state"
import {keymap, KeyBinding} from "@codemirror/view"
import {Completion} from "./completion"
import {completionState, State} from "./state"
import {CompletionConfig, completionConfig} from "./config"
import {completionPlugin, moveCompletionSelection, acceptCompletion, startCompletion, closeCompletion} from "./view"
import {baseTheme} from "./theme"

export {snippet, snippetCompletion, nextSnippetField, prevSnippetField, clearSnippet, snippetKeymap} from "./snippet"
export {Completion, CompletionContext, CompletionSource, CompletionResult, completeFromList, ifIn, ifNotIn} from "./completion"
export {startCompletion, closeCompletion, acceptCompletion, moveCompletionSelection} from "./view"
export {completeAnyWord} from "./word"

/// Returns an extension that enables autocompletion.
export function autocompletion(config: CompletionConfig = {}): Extension {
  return [
    completionState,
    completionConfig.of(config),
    completionPlugin,
    completionKeymapExt,
    baseTheme
  ]
}

/// Basic keybindings for autocompletion.
///
///  - Ctrl-Space: [`startCompletion`](#autocomplete.startCompletion)
///  - Escape: [`closeCompletion`](#autocomplete.closeCompletion)
///  - ArrowDown: [`moveCompletionSelection`](#autocomplete.moveCompletionSelection)`(true)`
///  - ArrowUp: [`moveCompletionSelection`](#autocomplete.moveCompletionSelection)`(false)`
///  - PageDown: [`moveCompletionSelection`](#autocomplete.moveCompletionSelection)`(true, "page")`
///  - PageDown: [`moveCompletionSelection`](#autocomplete.moveCompletionSelection)`(true, "page")`
///  - Enter: [`acceptCompletion`](#autocomplete.acceptCompletion)
export const completionKeymap: readonly KeyBinding[] = [
  {key: "Ctrl-Space", run: startCompletion},
  {key: "Escape", run: closeCompletion},
  {key: "ArrowDown", run: moveCompletionSelection(true)},
  {key: "ArrowUp", run: moveCompletionSelection(false)},
  {key: "PageDown", run: moveCompletionSelection(true, "page")},
  {key: "PageUp", run: moveCompletionSelection(false, "page")},
  {key: "Enter", run: acceptCompletion}
]

const completionKeymapExt = Prec.override(keymap.computeN([completionConfig], state => 
  state.facet(completionConfig).defaultKeymap ? [completionKeymap] : []))

/// Get the current completion status. When completions are available,
/// this will return `"active"`. When completions are pending (in the
/// process of being queried), this returns `"pending"`. Otherwise, it
/// returns `null`.
export function completionStatus(state: EditorState): null | "active" | "pending" {
  let cState = state.field(completionState, false)
  return cState && cState.active.some(a => a.state == State.Pending) ? "pending"
    : cState && cState.active.some(a => a.state != State.Inactive) ? "active" : null
}

/// Returns the available completions as an array.
export function currentCompletions(state: EditorState): readonly Completion[] {
  let open = state.field(completionState, false)?.open
  return open ? open.options.map(o => o.completion) : []
}
