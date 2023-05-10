import {Prec, Extension, EditorState, StateEffect} from "@codemirror/state"
import {keymap, KeyBinding} from "@codemirror/view"
import {Completion, Option} from "./completion"
import {completionState, State, setSelectedEffect} from "./state"
import {CompletionConfig, completionConfig} from "./config"
import {completionPlugin, moveCompletionSelection, acceptCompletion, startCompletion, closeCompletion} from "./view"
import {baseTheme} from "./theme"

export {snippet, snippetCompletion, nextSnippetField, prevSnippetField,
        hasNextSnippetField, hasPrevSnippetField, clearSnippet, snippetKeymap} from "./snippet"
export {Completion, CompletionSection, CompletionContext, CompletionSource, CompletionResult, pickedCompletion,
        completeFromList, ifIn, ifNotIn, insertCompletionText} from "./completion"
export {startCompletion, closeCompletion, acceptCompletion, moveCompletionSelection} from "./view"
export {completeAnyWord} from "./word"
export {CloseBracketConfig, closeBrackets, closeBracketsKeymap, deleteBracketPair, insertBracket} from "./closebrackets"

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

const completionKeymapExt = Prec.highest(keymap.computeN([completionConfig], state => 
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

const completionArrayCache: WeakMap<readonly Option[], readonly Completion[]> = new WeakMap

/// Returns the available completions as an array.
export function currentCompletions(state: EditorState): readonly Completion[] {
  let open = state.field(completionState, false)?.open
  if (!open || open.disabled) return []
  let completions = completionArrayCache.get(open.options)
  if (!completions)
    completionArrayCache.set(open.options, completions = open.options.map(o => o.completion))
  return completions
}

/// Return the currently selected completion, if any.
export function selectedCompletion(state: EditorState): Completion | null {
  let open = state.field(completionState, false)?.open
  return open && !open.disabled && open.selected >= 0 ? open.options[open.selected].completion : null
}

/// Returns the currently selected position in the active completion
/// list, or null if no completions are active.
export function selectedCompletionIndex(state: EditorState): number | null {
  let open = state.field(completionState, false)?.open
  return open && !open.disabled && open.selected >= 0 ? open.selected : null
}

/// Create an effect that can be attached to a transaction to change
/// the currently selected completion.
export function setSelectedCompletion(index: number): StateEffect<unknown> {
  return setSelectedEffect.of(index)
}
