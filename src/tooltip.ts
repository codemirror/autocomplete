import {EditorView, ViewUpdate, logException, TooltipView, Rect} from "@codemirror/view"
import {StateField, StateEffect, EditorState} from "@codemirror/state"
import {CompletionState} from "./state"
import {completionConfig, CompletionConfig} from "./config"
import {Option, Completion, CompletionInfo, closeCompletionEffect} from "./completion"

export const setSelectedEffect = StateEffect.define<number>()

type OptionContentSource =
  (completion: Completion, state: EditorState, view: EditorView, match: readonly number[]) => Node | null

function optionContent(config: Required<CompletionConfig>): OptionContentSource[] {
  let content = config.addToOptions.slice() as {render: OptionContentSource, position: number}[]
  if (config.icons) content.push({
    render(completion: Completion) {
      let icon = document.createElement("div")
      icon.classList.add("cm-completionIcon")
      if (completion.type)
        icon.classList.add(...completion.type.split(/\s+/g).map(cls => "cm-completionIcon-" + cls))
      icon.setAttribute("aria-hidden", "true")
      return icon
    },
    position: 20
  })
  content.push({
    render(completion: Completion, _s: EditorState, _v: EditorView, match: readonly number[]) {
      let labelElt = document.createElement("span")
      labelElt.className = "cm-completionLabel"
      let label = completion.displayLabel || completion.label, off = 0
      for (let j = 0; j < match.length;) {
        let from = match[j++], to = match[j++]
        if (from > off) labelElt.appendChild(document.createTextNode(label.slice(off, from)))
        let span = labelElt.appendChild(document.createElement("span"))
        span.appendChild(document.createTextNode(label.slice(from, to)))
        span.className = "cm-completionMatchedText"
        off = to
      }
      if (off < label.length) labelElt.appendChild(document.createTextNode(label.slice(off)))
      return labelElt
    },
    position: 50
  }, {
    render(completion: Completion) {
      if (!completion.detail) return null
      let detailElt = document.createElement("span")
      detailElt.className = "cm-completionDetail"
      detailElt.textContent = completion.detail
      return detailElt
    },
    position: 80
  })
  return content.sort((a, b) => a.position - b.position).map(a => a.render)
}

function rangeAroundSelected(total: number, selected: number, max: number) {
  if (total <= max) return {from: 0, to: total}
  if (selected < 0) selected = 0
  if (selected <= (total >> 1)) {
    let off = Math.floor(selected / max)
    return {from: off * max, to: (off + 1) * max}
  }
  let off = Math.floor((total - selected) / max)
  return {from: total - (off + 1) * max, to: total - off * max}
}

class CompletionTooltip {
  dom: HTMLElement
  info: HTMLElement | null = null
  infoDestroy: (() => void) | null = null
  declare list: HTMLElement
  placeInfoReq = {
    read: () => this.measureInfo(),
    write: (pos: {style?: string, class?: string} | null) => this.placeInfo(pos),
    key: this
  }
  range: {from: number, to: number}
  space: Rect | null = null
  optionContent: OptionContentSource[]
  tooltipClass: (state: EditorState) => string
  currentClass = ""
  optionClass: (option: Completion) => string

  constructor(readonly view: EditorView,
              readonly stateField: StateField<CompletionState>,
              readonly applyCompletion: (view: EditorView, option: Option) => void) {
    let cState = view.state.field(stateField)
    let {options, selected} = cState.open!
    let config = view.state.facet(completionConfig)
    this.optionContent = optionContent(config)
    this.optionClass = config.optionClass
    this.tooltipClass = config.tooltipClass

    this.range = rangeAroundSelected(options.length, selected, config.maxRenderedOptions)

    this.dom = document.createElement("div")
    this.dom.className = "cm-tooltip-autocomplete"
    this.updateTooltipClass(view.state)
    this.dom.addEventListener("mousedown", (e: MouseEvent) => {
      let {options} = view.state.field(stateField).open!
      for (let dom = e.target as HTMLElement | null, match; dom && dom != this.dom; dom = dom.parentNode as HTMLElement) {
        if (dom.nodeName == "LI" && (match = /-(\d+)$/.exec(dom.id)) && +match[1] < options.length) {
          this.applyCompletion(view, options[+match[1]])
          e.preventDefault()
          return
        }
      }
      if (e.target == this.list) {
        let move = this.list.classList.contains("cm-completionListIncompleteTop") &&
          e.clientY < (this.list.firstChild as HTMLElement).getBoundingClientRect().top ? this.range.from - 1 :
          this.list.classList.contains("cm-completionListIncompleteBottom") &&
          e.clientY > (this.list.lastChild as HTMLElement).getBoundingClientRect().bottom ? this.range.to : null
        if (move != null) {
          view.dispatch({effects: setSelectedEffect.of(move)})
          e.preventDefault()
        }
      }
    })
    this.dom.addEventListener("focusout", (e: FocusEvent) => {
      let state = view.state.field(this.stateField, false)
      if (state && state.tooltip && view.state.facet(completionConfig).closeOnBlur &&
          e.relatedTarget != view.contentDOM)
        view.dispatch({effects: closeCompletionEffect.of(null)})
    })
    this.showOptions(options, cState.id)
  }

  mount() { this.updateSel() }

  showOptions(options: readonly Option[], id: string) {
    if (this.list) this.list.remove()
    this.list = this.dom.appendChild(this.createListBox(options, id, this.range))
    this.list.addEventListener("scroll", () => {
      if (this.info) this.view.requestMeasure(this.placeInfoReq)
    })
  }

  update(update: ViewUpdate) {
    let cState = update.state.field(this.stateField)
    let prevState = update.startState.field(this.stateField)
    this.updateTooltipClass(update.state)
    if (cState != prevState) {
      let {options, selected, disabled} = cState.open!
      if (!prevState.open || prevState.open.options != options) {
        this.range = rangeAroundSelected(options.length, selected, update.state.facet(completionConfig).maxRenderedOptions)
        this.showOptions(options, cState.id)
      }
      this.updateSel()
      if (disabled != prevState.open?.disabled)
        this.dom.classList.toggle("cm-tooltip-autocomplete-disabled", !!disabled)
    }
  }

  updateTooltipClass(state: EditorState) {
    let cls = this.tooltipClass(state)
    if (cls != this.currentClass) {
      for (let c of this.currentClass.split(" ")) if (c) this.dom.classList.remove(c)
      for (let c of cls.split(" ")) if (c) this.dom.classList.add(c)
      this.currentClass = cls
    }
  }

  positioned(space: Rect) {
    this.space = space
    if (this.info) this.view.requestMeasure(this.placeInfoReq)
  }

  updateSel() {
    let cState = this.view.state.field(this.stateField), open = cState.open!
    if (open.selected > -1 && open.selected < this.range.from || open.selected >= this.range.to) {
      this.range = rangeAroundSelected(open.options.length, open.selected,
                                       this.view.state.facet(completionConfig).maxRenderedOptions)
      this.showOptions(open.options, cState.id)
    }
    let newSel = this.updateSelectedOption(open.selected)
    if (newSel) {
      this.destroyInfo()
      let {completion} = open.options[open.selected]
      let {info} = completion
      if (!info) return
      let infoResult = typeof info === "string" ? document.createTextNode(info) : info(completion)
      if (!infoResult) return
      if ("then" in infoResult) {
        infoResult.then(obj => {
          if (obj && this.view.state.field(this.stateField, false) == cState)
            this.addInfoPane(obj, completion)
        }).catch(e => logException(this.view.state, e, "completion info"))
      } else {
        this.addInfoPane(infoResult, completion)
        newSel.setAttribute("aria-describedby", this.info!.id)
      }
    }
  }

  addInfoPane(content: NonNullable<CompletionInfo>, completion: Completion) {
    this.destroyInfo()
    let wrap = this.info = document.createElement("div")
    wrap.className = "cm-tooltip cm-completionInfo"
    wrap.id = "cm-completionInfo-" + Math.floor(Math.random() * 0xffff).toString(16)
    if ((content as Node).nodeType != null) {
      wrap.appendChild(content as Node)
      this.infoDestroy = null
    } else {
      let {dom, destroy} = content as {dom: Node, destroy?(): void}
      wrap.appendChild(dom)
      this.infoDestroy = destroy || null
    }
    this.dom.appendChild(wrap)
    this.view.requestMeasure(this.placeInfoReq)
  }

  updateSelectedOption(selected: number) {
    let set: null | HTMLElement = null
    for (let opt = this.list.firstChild as (HTMLElement | null), i = this.range.from; opt;
         opt = opt.nextSibling as (HTMLElement | null), i++) {
      if (opt.nodeName != "LI" || !opt.id) {
        i-- // A section header
      } else if (i == selected) {
        if (!opt.hasAttribute("aria-selected")) {
          opt.setAttribute("aria-selected", "true")
          set = opt
        }
      } else {
        if (opt.hasAttribute("aria-selected")) {
          opt.removeAttribute("aria-selected")
          opt.removeAttribute("aria-describedby")
        }
      }
    }
    if (set) scrollIntoView(this.list, set)
    return set
  }

  measureInfo() {
    let sel = this.dom.querySelector("[aria-selected]") as HTMLElement | null
    if (!sel || !this.info) return null
    let listRect = this.dom.getBoundingClientRect()
    let infoRect = this.info!.getBoundingClientRect()
    let selRect = sel.getBoundingClientRect()
    let space = this.space
    if (!space) {
      let docElt = this.dom.ownerDocument.documentElement
      space = {left: 0, top: 0, right: docElt.clientWidth, bottom: docElt.clientHeight}
    }
    if (selRect.top > Math.min(space.bottom, listRect.bottom) - 10 ||
        selRect.bottom < Math.max(space.top, listRect.top) + 10)
      return null
    return (this.view.state.facet(completionConfig).positionInfo as any)(
      this.view, listRect, selRect, infoRect, space, this.dom)
  }

  placeInfo(pos: {style?: string, class?: string} | null) {
    if (this.info) {
      if (pos) {
        if (pos.style) this.info.style.cssText = pos.style
        this.info.className = "cm-tooltip cm-completionInfo " + (pos.class || "")
      } else {
        this.info.style.cssText = "top: -1e6px"
      }
    }
  }

  createListBox(options: readonly Option[], id: string, range: {from: number, to: number}) {
    const ul = document.createElement("ul")
    ul.id = id
    ul.setAttribute("role", "listbox")
    ul.setAttribute("aria-expanded", "true")
    ul.setAttribute("aria-label", this.view.state.phrase("Completions"))
    ul.addEventListener("mousedown", e => {
      // Prevent focus change when clicking the scrollbar
      if (e.target == ul) e.preventDefault()
    })
    let curSection: string | null = null
    for (let i = range.from; i < range.to; i++) {
      let {completion, match} = options[i], {section} = completion
      if (section) {
        let name = typeof section == "string" ? section : section.name
        if (name != curSection && (i > range.from || range.from == 0)) {
          curSection = name
          if (typeof section != "string" && section.header) {
            ul.appendChild(section.header(section))
          } else {
            let header = ul.appendChild(document.createElement("completion-section"))
            header.textContent = name
          }
        }
      }
      const li = ul.appendChild(document.createElement("li"))
      li.id = id + "-" + i
      li.setAttribute("role", "option")
      let cls = this.optionClass(completion)
      if (cls) li.className = cls
      for (let source of this.optionContent) {
        let node = source(completion, this.view.state, this.view, match)
        if (node) li.appendChild(node)
      }
    }
    if (range.from) ul.classList.add("cm-completionListIncompleteTop")
    if (range.to < options.length) ul.classList.add("cm-completionListIncompleteBottom")
    return ul
  }

  destroyInfo() {
    if (this.info) {
      if (this.infoDestroy) this.infoDestroy()
      this.info.remove()
      this.info = null
    }
  }

  destroy() {
    this.destroyInfo()
  }
}

export function completionTooltip(stateField: StateField<CompletionState>,
                                  applyCompletion: (view: EditorView, option: Option) => void) {
  return (view: EditorView): TooltipView => new CompletionTooltip(view, stateField, applyCompletion)
}

function scrollIntoView(container: HTMLElement, element: HTMLElement) {
  let parent = container.getBoundingClientRect()
  let self = element.getBoundingClientRect()
  let scaleY = parent.height / container.offsetHeight
  if (self.top < parent.top) container.scrollTop -= (parent.top - self.top) / scaleY
  else if (self.bottom > parent.bottom) container.scrollTop += (self.bottom - parent.bottom) / scaleY
}
