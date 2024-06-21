import {EditorView, Command, ViewPlugin, PluginValue, ViewUpdate, logException,
        getTooltip, TooltipView} from "@codemirror/view"
import {Transaction, Prec} from "@codemirror/state"
import {completionState, setSelectedEffect, setActiveEffect, State,
        ActiveSource, ActiveResult, getUpdateType, UpdateType, applyCompletion} from "./state"
import {completionConfig} from "./config"
import {cur, CompletionResult, CompletionContext, startCompletionEffect, closeCompletionEffect} from "./completion"

/// Returns a command that moves the completion selection forward or
/// backward by the given amount.
export function moveCompletionSelection(forward: boolean, by: "option" | "page" = "option"): Command {
  return (view: EditorView) => {
    let cState = view.state.field(completionState, false)
    if (!cState || !cState.open || cState.open.disabled ||
        Date.now() - cState.open.timestamp < view.state.facet(completionConfig).interactionDelay)
      return false
    let step = 1, tooltip: TooltipView | null
    if (by == "page" && (tooltip = getTooltip(view, cState.open.tooltip)))
      step = Math.max(2, Math.floor(tooltip.dom.offsetHeight /
        (tooltip.dom.querySelector("li") as HTMLElement).offsetHeight) - 1)
    let {length} = cState.open.options
    let selected = cState.open.selected > -1 ? cState.open.selected + step * (forward ? 1 : -1) : forward ? 0 : length - 1
    if (selected < 0) selected = by == "page" ? 0 : length - 1
    else if (selected >= length) selected = by == "page" ? length - 1 : 0
    view.dispatch({effects: setSelectedEffect.of(selected)})
    return true
  }
}

/// Accept the current completion.
export const acceptCompletion: Command = (view: EditorView) => {
  let cState = view.state.field(completionState, false)
  if (view.state.readOnly || !cState || !cState.open || cState.open.selected < 0 || cState.open.disabled ||
      Date.now() - cState.open.timestamp < view.state.facet(completionConfig).interactionDelay)
    return false
  return applyCompletion(view, cState.open.options[cState.open.selected])
  return true
}

/// Explicitly start autocompletion.
export const startCompletion: Command = (view: EditorView) => {
  let cState = view.state.field(completionState, false)
  if (!cState) return false
  view.dispatch({effects: startCompletionEffect.of(true)})
  return true
}

/// Close the currently active completion.
export const closeCompletion: Command = (view: EditorView) => {
  let cState = view.state.field(completionState, false)
  if (!cState || !cState.active.some(a => a.state != State.Inactive)) return false
  view.dispatch({effects: closeCompletionEffect.of(null)})
  return true
}

class RunningQuery {
  time = Date.now()
  updates: Transaction[] = []
  // Note that 'undefined' means 'not done yet', whereas 'null' means
  // 'query returned null'.
  done: undefined | CompletionResult | null = undefined

  constructor(readonly active: ActiveSource,
              readonly context: CompletionContext) {}
}

const MaxUpdateCount = 50, MinAbortTime = 1000

const enum CompositionState { None, Started, Changed, ChangedAndMoved }

export const completionPlugin = ViewPlugin.fromClass(class implements PluginValue {
  debounceUpdate = -1
  running: RunningQuery[] = []
  debounceAccept = -1
  pendingStart = false
  composing = CompositionState.None

  constructor(readonly view: EditorView) {
    for (let active of view.state.field(completionState).active)
      if (active.state == State.Pending) this.startQuery(active)
  }

  update(update: ViewUpdate) {
    let cState = update.state.field(completionState)
    let conf = update.state.facet(completionConfig)
    if (!update.selectionSet && !update.docChanged && update.startState.field(completionState) == cState) return

    let doesReset = update.transactions.some(tr => {
      let type = getUpdateType(tr, conf)
      return (type & UpdateType.Reset) || (tr.selection || tr.docChanged) && !(type & UpdateType.SimpleInteraction)
    })
    for (let i = 0; i < this.running.length; i++) {
      let query = this.running[i]
      if (doesReset ||
          query.updates.length + update.transactions.length > MaxUpdateCount && Date.now() - query.time > MinAbortTime) {
        for (let handler of query.context.abortListeners!) {
          try { handler() }
          catch(e) { logException(this.view.state, e) }
        }
        query.context.abortListeners = null
        this.running.splice(i--, 1)
      } else {
        query.updates.push(...update.transactions)
      }
    }

    if (this.debounceUpdate > -1) clearTimeout(this.debounceUpdate)
    if (update.transactions.some(tr => tr.effects.some(e => e.is(startCompletionEffect)))) this.pendingStart = true
    let delay = this.pendingStart ? 50 : conf.activateOnTypingDelay
    this.debounceUpdate = cState.active.some(a => a.state == State.Pending && !this.running.some(q => q.active.source == a.source))
      ? setTimeout(() => this.startUpdate(), delay) : -1

    if (this.composing != CompositionState.None) for (let tr of update.transactions) {
      if (tr.isUserEvent("input.type"))
        this.composing = CompositionState.Changed
      else if (this.composing == CompositionState.Changed && tr.selection)
        this.composing = CompositionState.ChangedAndMoved
    }
  }

  startUpdate() {
    this.debounceUpdate = -1
    this.pendingStart = false
    let {state} = this.view, cState = state.field(completionState)
    for (let active of cState.active) {
      if (active.state == State.Pending && !this.running.some(r => r.active.source == active.source))
        this.startQuery(active)
    }
  }

  startQuery(active: ActiveSource) {
    let {state} = this.view, pos = cur(state)
    let context = new CompletionContext(state, pos, active.explicitPos == pos)
    let pending = new RunningQuery(active, context)
    this.running.push(pending)
    Promise.resolve(active.source(context)).then(result => {
      if (!pending.context.aborted) {
        pending.done = result || null
        this.scheduleAccept()
      }
    }, err => {
      this.view.dispatch({effects: closeCompletionEffect.of(null)})
      logException(this.view.state, err)
    })
  }

  scheduleAccept() {
    if (this.running.every(q => q.done !== undefined))
      this.accept()
    else if (this.debounceAccept < 0)
      this.debounceAccept = setTimeout(() => this.accept(),
                                       this.view.state.facet(completionConfig).updateSyncTime)
  }

  // For each finished query in this.running, try to create a result
  // or, if appropriate, restart the query.
  accept() {
    if (this.debounceAccept > -1) clearTimeout(this.debounceAccept)
    this.debounceAccept = -1

    let updated: ActiveSource[] = []
    let conf = this.view.state.facet(completionConfig)
    for (let i = 0; i < this.running.length; i++) {
      let query = this.running[i]
      if (query.done === undefined) continue
      this.running.splice(i--, 1)

      if (query.done) {
        let active: ActiveSource = new ActiveResult(
          query.active.source, query.active.explicitPos, query.done, query.done.from,
          query.done.to ?? cur(query.updates.length ? query.updates[0].startState : this.view.state))
        // Replay the transactions that happened since the start of
        // the request and see if that preserves the result
        for (let tr of query.updates) active = active.update(tr, conf)
        if (active.hasResult()) {
          updated.push(active)
          continue
        }
      }

      let current = this.view.state.field(completionState).active.find(a => a.source == query.active.source)
      if (current && current.state == State.Pending) {
        if (query.done == null) {
          // Explicitly failed. Should clear the pending status if it
          // hasn't been re-set in the meantime.
          let active = new ActiveSource(query.active.source, State.Inactive)
          for (let tr of query.updates) active = active.update(tr, conf)
          if (active.state != State.Pending) updated.push(active)
        } else {
          // Cleared by subsequent transactions. Restart.
          this.startQuery(current)
        }
      }
    }

    if (updated.length) this.view.dispatch({effects: setActiveEffect.of(updated)})
  }
}, {
  eventHandlers: {
    blur(event) {
      let state = this.view.state.field(completionState, false)
      if (state && state.tooltip && this.view.state.facet(completionConfig).closeOnBlur) {
        let dialog = state.open && getTooltip(this.view, state.open.tooltip)
        if (!dialog || !dialog.dom.contains(event.relatedTarget as HTMLElement))
          setTimeout(() => this.view.dispatch({effects: closeCompletionEffect.of(null)}), 10)
      }
    },
    compositionstart() {
      this.composing = CompositionState.Started
    },
    compositionend() {
      if (this.composing == CompositionState.ChangedAndMoved) {
        // Safari fires compositionend events synchronously, possibly
        // from inside an update, so dispatch asynchronously to avoid reentrancy
        setTimeout(() => this.view.dispatch({effects: startCompletionEffect.of(false)}), 20)
      }
      this.composing = CompositionState.None
    }
  }
})

const windows = typeof navigator == "object" && /Win/.test(navigator.platform)

export const commitCharacters = Prec.highest(EditorView.domEventHandlers({
  keydown(event, view) {
    let field = view.state.field(completionState, false)
    if (!field || !field.open || field.open.disabled || field.open.selected < 0 ||
        event.key.length > 1 || event.ctrlKey && !(windows && event.altKey) || event.metaKey)
      return false
    let option = field.open.options[field.open.selected]
    let result = field.active.find(a => a.source == option.source) as ActiveResult
    let commitChars = option.completion.commitCharacters || result.result.commitCharacters
    if (commitChars && commitChars.indexOf(event.key) > -1)
      applyCompletion(view, option)
    return false
  }
}))
