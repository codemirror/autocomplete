import {EditorView} from "@codemirror/view"
import {EditorState, StateEffect, Annotation, EditorSelection, TransactionSpec} from "@codemirror/state"
import {syntaxTree} from "@codemirror/language"
import {SyntaxNode} from "@lezer/common"

/// Objects type used to represent individual completions.
export interface Completion {
  /// The label to show in the completion picker. This is what input
  /// is matched against to determine whether a completion matches (and
  /// how well it matches).
  label: string
  /// An optional override for the completion's visible label. When
  /// using this, matched characters will only be highlighted if you
  /// provide a [`getMatch`](#autocomplete.CompletionResult.getMatch)
  /// function.
  displayLabel?: string
  /// An optional short piece of information to show (with a different
  /// style) after the label.
  detail?: string
  /// Additional info to show when the completion is selected. Can be
  /// a plain string or a function that'll render the DOM structure to
  /// show when invoked.
  info?: string | ((completion: Completion) => CompletionInfo | Promise<CompletionInfo>)
  /// How to apply the completion. The default is to replace it with
  /// its [label](#autocomplete.Completion.label). When this holds a
  /// string, the completion range is replaced by that string. When it
  /// is a function, that function is called to perform the
  /// completion. If it fires a transaction, it is responsible for
  /// adding the [`pickedCompletion`](#autocomplete.pickedCompletion)
  /// annotation to it.
  apply?: string | ((view: EditorView, completion: Completion, from: number, to: number) => void)
  /// The type of the completion. This is used to pick an icon to show
  /// for the completion. Icons are styled with a CSS class created by
  /// appending the type name to `"cm-completionIcon-"`. You can
  /// define or restyle icons by defining these selectors. The base
  /// library defines simple icons for `class`, `constant`, `enum`,
  /// `function`, `interface`, `keyword`, `method`, `namespace`,
  /// `property`, `text`, `type`, and `variable`.
  ///
  /// Multiple types can be provided by separating them with spaces.
  type?: string
  /// When this option is selected, and one of these characters is
  /// typed, insert the completion before typing the character.
  commitCharacters?: readonly string[],
  /// When given, should be a number from -99 to 99 that adjusts how
  /// this completion is ranked compared to other completions that
  /// match the input as well as this one. A negative number moves it
  /// down the list, a positive number moves it up.
  boost?: number
  /// Can be used to divide the completion list into sections.
  /// Completions in a given section (matched by name) will be grouped
  /// together, with a heading above them. Options without section
  /// will appear above all sections. A string value is equivalent to
  /// a `{name}` object.
  section?: string | CompletionSection
}

/// The type returned from
/// [`Completion.info`](#autocomplete.Completion.info). May be a DOM
/// node, null to indicate there is no info, or an object with an
/// optional `destroy` method that cleans up the node.
export type CompletionInfo = Node | null | {dom: Node, destroy?(): void}

/// Object used to describe a completion
/// [section](#autocomplete.Completion.section). It is recommended to
/// create a shared object used by all the completions in a given
/// section.
export interface CompletionSection {
  /// The name of the section. If no `render` method is present, this
  /// will be displayed above the options.
  name: string
  /// An optional function that renders the section header. Since the
  /// headers are shown inside a list, you should make sure the
  /// resulting element has a `display: list-item` style.
  header?: (section: CompletionSection) => HTMLElement
  /// By default, sections are ordered alphabetically by name. To
  /// specify an explicit order, `rank` can be used. Sections with a
  /// lower rank will be shown above sections with a higher rank.
  rank?: number
}

/// An instance of this is passed to completion source functions.
export class CompletionContext {
  /// @internal
  abortListeners: (() => void)[] | null = []

  /// Create a new completion context. (Mostly useful for testing
  /// completion sources—in the editor, the extension will create
  /// these for you.)
  constructor(
    /// The editor state that the completion happens in.
    readonly state: EditorState,
    /// The position at which the completion is happening.
    readonly pos: number,
    /// Indicates whether completion was activated explicitly, or
    /// implicitly by typing. The usual way to respond to this is to
    /// only return completions when either there is part of a
    /// completable entity before the cursor, or `explicit` is true.
    readonly explicit: boolean
  ) {}

  /// Get the extent, content, and (if there is a token) type of the
  /// token before `this.pos`.
  tokenBefore(types: readonly string[]) {
    let token: SyntaxNode | null = syntaxTree(this.state).resolveInner(this.pos, -1)
    while (token && types.indexOf(token.name) < 0) token = token.parent
    return token ? {from: token.from, to: this.pos,
                    text: this.state.sliceDoc(token.from, this.pos),
                    type: token.type} : null
  }

  /// Get the match of the given expression directly before the
  /// cursor.
  matchBefore(expr: RegExp) {
    let line = this.state.doc.lineAt(this.pos)
    let start = Math.max(line.from, this.pos - 250)
    let str = line.text.slice(start - line.from, this.pos - line.from)
    let found = str.search(ensureAnchor(expr, false))
    return found < 0 ? null : {from: start + found, to: this.pos, text: str.slice(found)}
  }

  /// Yields true when the query has been aborted. Can be useful in
  /// asynchronous queries to avoid doing work that will be ignored.
  get aborted() { return this.abortListeners == null }

  /// Allows you to register abort handlers, which will be called when
  /// the query is
  /// [aborted](#autocomplete.CompletionContext.aborted).
  addEventListener(type: "abort", listener: () => void) {
    if (type == "abort" && this.abortListeners) this.abortListeners.push(listener)
  }
}

function toSet(chars: {[ch: string]: true}) {
  let flat = Object.keys(chars).join("")
  let words = /\w/.test(flat)
  if (words) flat = flat.replace(/\w/g, "")
  return `[${words ? "\\w" : ""}${flat.replace(/[^\w\s]/g, "\\$&")}]`
}

function prefixMatch(options: readonly Completion[]) {
  let first = Object.create(null), rest = Object.create(null)
  for (let {label} of options) {
    first[label[0]] = true
    for (let i = 1; i < label.length; i++) rest[label[i]] = true
  }
  let source = toSet(first) + toSet(rest) + "*$"
  return [new RegExp("^" + source), new RegExp(source)]
}

/// Given a a fixed array of options, return an autocompleter that
/// completes them.
export function completeFromList(list: readonly (string | Completion)[]): CompletionSource {
  let options = list.map(o => typeof o == "string" ? {label: o} : o) as Completion[]
  let [validFor, match] = options.every(o => /^\w+$/.test(o.label)) ? [/\w*$/, /\w+$/] : prefixMatch(options)
  return (context: CompletionContext) => {
    let token = context.matchBefore(match)
    return token || context.explicit ? {from: token ? token.from : context.pos, options, validFor} : null
  }
}

/// Wrap the given completion source so that it will only fire when the
/// cursor is in a syntax node with one of the given names.
export function ifIn(nodes: readonly string[], source: CompletionSource): CompletionSource {
  return (context: CompletionContext) => {
    for (let pos: SyntaxNode | null = syntaxTree(context.state).resolveInner(context.pos, -1); pos; pos = pos.parent) {
      if (nodes.indexOf(pos.name) > -1) return source(context)
      if (pos.type.isTop) break
    }
    return null
  }
}

/// Wrap the given completion source so that it will not fire when the
/// cursor is in a syntax node with one of the given names.
export function ifNotIn(nodes: readonly string[], source: CompletionSource): CompletionSource {
  return (context: CompletionContext) => {
    for (let pos: SyntaxNode | null = syntaxTree(context.state).resolveInner(context.pos, -1); pos; pos = pos.parent) {
      if (nodes.indexOf(pos.name) > -1) return null
      if (pos.type.isTop) break
    }
    return source(context)
  }
}

/// The function signature for a completion source. Such a function
/// may return its [result](#autocomplete.CompletionResult)
/// synchronously or as a promise. Returning null indicates no
/// completions are available.
export type CompletionSource =
  (context: CompletionContext) => CompletionResult | null | Promise<CompletionResult | null>

/// Interface for objects returned by completion sources.
export interface CompletionResult {
  /// The start of the range that is being completed.
  from: number
  /// The end of the range that is being completed. Defaults to the
  /// main cursor position.
  to?: number
  /// The completions returned. These don't have to be compared with
  /// the input by the source—the autocompletion system will do its
  /// own matching (against the text between `from` and `to`) and
  /// sorting.
  options: readonly Completion[]
  /// When given, further typing or deletion that causes the part of
  /// the document between ([mapped](#state.ChangeDesc.mapPos)) `from`
  /// and `to` to match this regular expression or predicate function
  /// will not query the completion source again, but continue with
  /// this list of options. This can help a lot with responsiveness,
  /// since it allows the completion list to be updated synchronously.
  validFor?: RegExp | ((text: string, from: number, to: number, state: EditorState) => boolean)
  /// By default, the library filters and scores completions. Set
  /// `filter` to `false` to disable this, and cause your completions
  /// to all be included, in the order they were given. When there are
  /// other sources, unfiltered completions appear at the top of the
  /// list of completions. `validFor` must not be given when `filter`
  /// is `false`, because it only works when filtering.
  filter?: boolean
  /// When [`filter`](#autocomplete.CompletionResult.filter) is set to
  /// `false` or a completion has a
  /// [`displayLabel`](#autocomplete.Completion.displayLabel), this
  /// may be provided to compute the ranges on the label that match
  /// the input. Should return an array of numbers where each pair of
  /// adjacent numbers provide the start and end of a range. The
  /// second argument, the match found by the library, is only passed
  /// when `filter` isn't `false`.
  getMatch?: (completion: Completion, matched?: readonly number[]) => readonly number[]
  /// Synchronously update the completion result after typing or
  /// deletion. If given, this should not do any expensive work, since
  /// it will be called during editor state updates. The function
  /// should make sure (similar to
  /// [`validFor`](#autocomplete.CompletionResult.validFor)) that the
  /// completion still applies in the new state.
  update?: (current: CompletionResult, from: number, to: number, context: CompletionContext) => CompletionResult | null
  /// Set a default set of [commit
  /// characters](#autocomplete.Completion.commitCharacters) for all
  /// options in this result.
  commitCharacters?: readonly string[]
}

export class Option {
  constructor(readonly completion: Completion,
              readonly source: CompletionSource,
              readonly match: readonly number[],
              public score: number) {}
}

export function cur(state: EditorState) { return state.selection.main.from }

// Make sure the given regexp has a $ at its end and, if `start` is
// true, a ^ at its start.
export function ensureAnchor(expr: RegExp, start: boolean) {
  let {source} = expr
  let addStart = start && source[0] != "^", addEnd = source[source.length - 1] != "$"
  if (!addStart && !addEnd) return expr
  return new RegExp(`${addStart ? "^" : ""}(?:${source})${addEnd ? "$" : ""}`,
                    expr.flags ?? (expr.ignoreCase ? "i" : ""))
}

/// This annotation is added to transactions that are produced by
/// picking a completion.
export const pickedCompletion = Annotation.define<Completion>()

/// Helper function that returns a transaction spec which inserts a
/// completion's text in the main selection range, and any other
/// selection range that has the same text in front of it.
export function insertCompletionText(state: EditorState, text: string, from: number, to: number): TransactionSpec {
  let {main} = state.selection, fromOff = from - main.from, toOff = to - main.from
  return {
    ...state.changeByRange(range => {
      if (range != main && from != to &&
          state.sliceDoc(range.from + fromOff, range.from + toOff) != state.sliceDoc(from, to))
        return {range}
      return {
        changes: {from: range.from + fromOff, to: to == main.from ? range.to : range.from + toOff, insert: text},
        range: EditorSelection.cursor(range.from + fromOff + text.length)
      }
    }),
    scrollIntoView: true,
    userEvent: "input.complete"
  }
}

const SourceCache = new WeakMap<readonly (string | Completion)[], CompletionSource>()

export function asSource(source: CompletionSource | readonly (string | Completion)[]): CompletionSource {
  if (!Array.isArray(source)) return source as CompletionSource
  let known = SourceCache.get(source)
  if (!known) SourceCache.set(source, known = completeFromList(source))
  return known
}

export const startCompletionEffect = StateEffect.define<boolean>()
export const closeCompletionEffect = StateEffect.define<null>()
