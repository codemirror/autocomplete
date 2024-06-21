import {EditorView, Tooltip, showTooltip} from "@codemirror/view"
import {Transaction, StateField, StateEffect, EditorState, ChangeDesc} from "@codemirror/state"
import {Option, CompletionSource, CompletionResult, cur, asSource,
        Completion, ensureAnchor, CompletionContext, CompletionSection,
        startCompletionEffect, closeCompletionEffect,
        insertCompletionText, pickedCompletion} from "./completion"
import {FuzzyMatcher, StrictMatcher} from "./filter"
import {completionTooltip} from "./tooltip"
import {CompletionConfig, completionConfig} from "./config"

// Used to pick a preferred option when two options with the same
// label occur in the result.
function score(option: Completion) {
  return (option.boost || 0) * 100 + (option.apply ? 10 : 0) + (option.info ? 5 : 0) +
    (option.type ? 1 : 0)
}

function sortOptions(active: readonly ActiveSource[], state: EditorState) {
  let options: Option[] = []
  let sections: null | CompletionSection[] = null
  let addOption = (option: Option) => {
    options.push(option)
    let {section} = option.completion
    if (section) {
      if (!sections) sections = []
      let name = typeof section == "string" ? section : section.name
      if (!sections.some(s => s.name == name)) sections.push(typeof section == "string" ? {name} : section)
    }
  }

  let conf = state.facet(completionConfig)
  for (let a of active) if (a.hasResult()) {
    let getMatch = a.result.getMatch
    if (a.result.filter === false) {
      for (let option of a.result.options) {
        addOption(new Option(option, a.source, getMatch ? getMatch(option) : [], 1e9 - options.length))
      }
    } else {
      let pattern = state.sliceDoc(a.from, a.to), match
      let matcher = conf.filterStrict ? new StrictMatcher(pattern) : new FuzzyMatcher(pattern)
      for (let option of a.result.options) if (match = matcher.match(option.label)) {
        let matched = !option.displayLabel ? match.matched : getMatch ? getMatch(option, match.matched) : []
        addOption(new Option(option, a.source, matched, match.score + (option.boost || 0)))
      }
    }
  }

  if (sections) {
    let sectionOrder: {[name: string]: number} = Object.create(null), pos = 0
    let cmp = (a: CompletionSection, b: CompletionSection) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || (a.name < b.name ? -1 : 1)
    for (let s of (sections as CompletionSection[]).sort(cmp)) {
      pos -= 1e5
      sectionOrder[s.name] = pos
    }
    for (let option of options) {
      let {section} = option.completion
      if (section) option.score += sectionOrder[typeof section == "string" ? section : section.name]
    }
  }

  let result = [], prev = null
  let compare = conf.compareCompletions
  for (let opt of options.sort((a, b) => (b.score - a.score) || compare(a.completion, b.completion))) {
    let cur = opt.completion
    if (!prev || prev.label != cur.label || prev.detail != cur.detail ||
        (prev.type != null && cur.type != null && prev.type != cur.type) ||
        prev.apply != cur.apply || prev.boost != cur.boost) result.push(opt)
    else if (score(opt.completion) > score(prev)) result[result.length - 1] = opt
    prev = opt.completion
  }
  return result
}

class CompletionDialog {
  constructor(readonly options: readonly Option[],
              readonly attrs: {[name: string]: string},
              readonly tooltip: Tooltip,
              readonly timestamp: number,
              readonly selected: number,
              readonly disabled: boolean) {}

  setSelected(selected: number, id: string) {
    return selected == this.selected || selected >= this.options.length ? this
      : new CompletionDialog(this.options, makeAttrs(id, selected), this.tooltip, this.timestamp, selected, this.disabled)
  }

  static build(
    active: readonly ActiveSource[],
    state: EditorState,
    id: string,
    prev: CompletionDialog | null,
    conf: Required<CompletionConfig>
  ): CompletionDialog | null {
    let options = sortOptions(active, state)
    if (!options.length) {
      return prev && active.some(a => a.state == State.Pending) ?
        new CompletionDialog(prev.options, prev.attrs, prev.tooltip, prev.timestamp, prev.selected, true) : null
    }
    let selected = state.facet(completionConfig).selectOnOpen ? 0 : -1
    if (prev && prev.selected != selected && prev.selected != -1) {
      let selectedValue = prev.options[prev.selected].completion
      for (let i = 0; i < options.length; i++) if (options[i].completion == selectedValue) {
        selected = i
        break
      }
    }
    return new CompletionDialog(options, makeAttrs(id, selected), {
      pos: active.reduce((a, b) => b.hasResult() ? Math.min(a, b.from) : a, 1e8),
      create: createTooltip,
      above: conf.aboveCursor,
    }, prev ? prev.timestamp : Date.now(), selected, false)
  }

  map(changes: ChangeDesc) {
    return new CompletionDialog(this.options, this.attrs, {...this.tooltip, pos: changes.mapPos(this.tooltip.pos)},
                                this.timestamp, this.selected, this.disabled)
  }
}

export class CompletionState {
  constructor(readonly active: readonly ActiveSource[],
              readonly id: string,
              readonly open: CompletionDialog | null) {}

  static start() {
    return new CompletionState(none, "cm-ac-" + Math.floor(Math.random() * 2e6).toString(36), null)
  }

  update(tr: Transaction) {
    let {state} = tr, conf = state.facet(completionConfig)
    let sources = conf.override ||
      state.languageDataAt<CompletionSource | readonly (string | Completion)[]>("autocomplete", cur(state)).map(asSource)
    let active: readonly ActiveSource[] = sources.map(source => {
      let value = this.active.find(s => s.source == source) ||
        new ActiveSource(source, this.active.some(a => a.state != State.Inactive) ? State.Pending : State.Inactive)
      return value.update(tr, conf)
    })
    if (active.length == this.active.length && active.every((a, i) => a == this.active[i])) active = this.active

    let open = this.open
    if (open && tr.docChanged) open = open.map(tr.changes)
    if (tr.selection || active.some(a => a.hasResult() && tr.changes.touchesRange(a.from, a.to)) ||
        !sameResults(active, this.active))
      open = CompletionDialog.build(active, state, this.id, open, conf)
    else if (open && open.disabled && !active.some(a => a.state == State.Pending))
      open = null

    if (!open && active.every(a => a.state != State.Pending) && active.some(a => a.hasResult()))
      active = active.map(a => a.hasResult() ? new ActiveSource(a.source, State.Inactive) : a)
    for (let effect of tr.effects) if (effect.is(setSelectedEffect)) open = open && open.setSelected(effect.value, this.id)

    return active == this.active && open == this.open ? this : new CompletionState(active, this.id, open)
  }

  get tooltip(): Tooltip | null { return this.open ? this.open.tooltip : null }

  get attrs() { return this.open ? this.open.attrs : this.active.length ? baseAttrs : noAttrs }
}

function sameResults(a: readonly ActiveSource[], b: readonly ActiveSource[]) {
  if (a == b) return true
  for (let iA = 0, iB = 0;;) {
    while (iA < a.length && !a[iA].hasResult) iA++
    while (iB < b.length && !b[iB].hasResult) iB++
    let endA = iA == a.length, endB = iB == b.length
    if (endA || endB) return endA == endB
    if ((a[iA++] as ActiveResult).result != (b[iB++] as ActiveResult).result) return false
  }
}

const baseAttrs = {
  "aria-autocomplete": "list"
}

const noAttrs = {}

function makeAttrs(id: string, selected: number) {
  let result: {[name: string]: string} = {
    "aria-autocomplete": "list",
    "aria-haspopup": "listbox",
    "aria-controls": id
  }
  if (selected > -1) result["aria-activedescendant"] = id + "-" + selected
  return result
}

const none: readonly any[] = []

export const enum State { Inactive = 0, Pending = 1, Result = 2 }

export const enum UpdateType {
  None = 0,
  Typing = 1,
  Backspacing = 2,
  SimpleInteraction = Typing | Backspacing,
  Activate = 4,
  Reset = 8,
  ResetIfTouching = 16
}
  
export function getUpdateType(tr: Transaction, conf: Required<CompletionConfig>): UpdateType {
  if (tr.isUserEvent("input.complete")) {
    let completion = tr.annotation(pickedCompletion)
    if (completion && conf.activateOnCompletion(completion)) return UpdateType.Activate | UpdateType.Reset
  }
  let typing = tr.isUserEvent("input.type")
  return typing && conf.activateOnTyping ? UpdateType.Activate | UpdateType.Typing
    : typing ? UpdateType.Typing
    : tr.isUserEvent("delete.backward") ? UpdateType.Backspacing
    : tr.selection ? UpdateType.Reset
    : tr.docChanged ? UpdateType.ResetIfTouching : UpdateType.None
}

export class ActiveSource {
  constructor(readonly source: CompletionSource,
              readonly state: State,
              readonly explicitPos: number = -1) {}

  hasResult(): this is ActiveResult { return false }

  update(tr: Transaction, conf: Required<CompletionConfig>): ActiveSource {
    let type = getUpdateType(tr, conf), value: ActiveSource = this
    if ((type & UpdateType.Reset) || (type & UpdateType.ResetIfTouching) && this.touches(tr))
      value = new ActiveSource(value.source, State.Inactive)
    if ((type & UpdateType.Activate) && value.state == State.Inactive)
      value = new ActiveSource(this.source, State.Pending)
    value = value.updateFor(tr, type)

    for (let effect of tr.effects) {
      if (effect.is(startCompletionEffect))
        value = new ActiveSource(value.source, State.Pending, effect.value ? cur(tr.state) : -1)
      else if (effect.is(closeCompletionEffect))
        value = new ActiveSource(value.source, State.Inactive)
      else if (effect.is(setActiveEffect))
        for (let active of effect.value) if (active.source == value.source) value = active
    }
    return value
  }

  updateFor(tr: Transaction, type: UpdateType): ActiveSource { return this.map(tr.changes) }

  map(changes: ChangeDesc) {
    return changes.empty || this.explicitPos < 0 ? this : new ActiveSource(this.source, this.state, changes.mapPos(this.explicitPos))
  }

  touches(tr: Transaction) {
    return tr.changes.touchesRange(cur(tr.state))
  }
}

export class ActiveResult extends ActiveSource {
  constructor(source: CompletionSource,
              explicitPos: number,
              readonly result: CompletionResult,
              readonly from: number,
              readonly to: number) {
    super(source, State.Result, explicitPos)
  }

  hasResult(): this is ActiveResult { return true }

  updateFor(tr: Transaction, type: UpdateType) {
    if (!(type & UpdateType.SimpleInteraction)) return this.map(tr.changes)
    let result = this.result as CompletionResult | null
    if (result!.map && !tr.changes.empty) result = result!.map(result!, tr.changes)
    let from = tr.changes.mapPos(this.from), to = tr.changes.mapPos(this.to, 1)
    let pos = cur(tr.state)
    if ((this.explicitPos < 0 ? pos <= from : pos < this.from) ||
        pos > to || !result ||
        (type & UpdateType.Backspacing) && cur(tr.startState) == this.from)
      return new ActiveSource(this.source, type & UpdateType.Activate ? State.Pending : State.Inactive)
    let explicitPos = this.explicitPos < 0 ? -1 : tr.changes.mapPos(this.explicitPos)
    if (checkValid(result.validFor, tr.state, from, to))
      return new ActiveResult(this.source, explicitPos, result, from, to)
    if (result.update &&
        (result = result.update(result, from, to, new CompletionContext(tr.state, pos, explicitPos >= 0))))
      return new ActiveResult(this.source, explicitPos, result, result.from, result.to ?? cur(tr.state))
    return new ActiveSource(this.source, State.Pending, explicitPos)
  }

  map(mapping: ChangeDesc) {
    if (mapping.empty) return this
    let result = this.result.map ? this.result.map(this.result, mapping) : this.result
    if (!result) return new ActiveSource(this.source, State.Inactive)
    return new ActiveResult(this.source, this.explicitPos < 0 ? -1 : mapping.mapPos(this.explicitPos), this.result,
                            mapping.mapPos(this.from), mapping.mapPos(this.to, 1))
  }

  touches(tr: Transaction) {
    return tr.changes.touchesRange(this.from, this.to)
  }
}

function checkValid(validFor: undefined | RegExp | ((text: string, from: number, to: number, state: EditorState) => boolean),
                    state: EditorState, from: number, to: number) {
  if (!validFor) return false
  let text = state.sliceDoc(from, to)
  return typeof validFor == "function" ? validFor(text, from, to, state) : ensureAnchor(validFor, true).test(text)
}

export const setActiveEffect = StateEffect.define<readonly ActiveSource[]>({
  map(sources, mapping) { return sources.map(s => s.map(mapping)) }
})
export const setSelectedEffect = StateEffect.define<number>()

export const completionState = StateField.define<CompletionState>({
  create() { return CompletionState.start() },

  update(value, tr) { return value.update(tr) },

  provide: f => [
    showTooltip.from(f, val => val.tooltip),
    EditorView.contentAttributes.from(f, state => state.attrs)
  ]
})

export function applyCompletion(view: EditorView, option: Option) {
  const apply = option.completion.apply || option.completion.label
  let result = view.state.field(completionState).active.find(a => a.source == option.source)
  if (!(result instanceof ActiveResult)) return false

  if (typeof apply == "string")
    view.dispatch({
      ...insertCompletionText(view.state, apply, result.from, result.to),
      annotations: pickedCompletion.of(option.completion)
    })
  else
    apply(view, option.completion, result.from, result.to)
  return true
}

const createTooltip = completionTooltip(completionState, applyCompletion)
