import {EditorView, ViewUpdate, Direction, logException} from "@codemirror/view"
import {StateField, EditorState} from "@codemirror/state"
import {TooltipView} from "@codemirror/tooltip"
import {CompletionState} from "./state"
import {completionConfig, CompletionConfig} from "./config"
import {Option, applyCompletion, Completion} from "./completion"

type OptionContentSource = (completion: Completion, state: EditorState, match: readonly number[]) => Node | null

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
    render(completion: Completion, _s: EditorState, match: readonly number[]) {
      let labelElt = document.createElement("span")
      labelElt.className = "cm-completionLabel"
      let {label} = completion, off = 0
      for (let j = 1; j < match.length;) {
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

function createInfoDialog(option: Option, view: EditorView) {
  let dom = document.createElement("div")
  dom.className = "cm-tooltip cm-completionInfo"
  let {info} = option.completion
  if (typeof info == "string") {
    dom.textContent = info
  } else {
    let content = info!(option.completion)
    if ((content as any).then)
      (content as Promise<Node>).then(node => dom.appendChild(node), e => logException(view.state, e, "completion info"))
    else
      dom.appendChild(content as Node)
  }
  return dom
}

function rangeAroundSelected(total: number, selected: number, max: number) {
  if (total <= max) return {from: 0, to: total}
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
  list: HTMLElement
  placeInfo = {
    read: () => this.measureInfo(),
    write: (pos: {left: boolean, top: number} | null) => this.positionInfo(pos),
    key: this
  }
  range: {from: number, to: number}
  optionContent: OptionContentSource[]
  optionClass: (option: Completion) => string

  constructor(readonly view: EditorView,
              readonly stateField: StateField<CompletionState>) {
    let cState = view.state.field(stateField)
    let {options, selected} = cState.open!
    let config = view.state.facet(completionConfig)
    this.optionContent = optionContent(config)
    this.optionClass = config.optionClass

    this.range = rangeAroundSelected(options.length, selected, config.maxRenderedOptions)

    this.dom = document.createElement("div")
    this.dom.className = "cm-tooltip-autocomplete"
    this.dom.addEventListener("mousedown", (e: MouseEvent) => {
      for (let dom = e.target as HTMLElement | null, match; dom && dom != this.dom; dom = dom.parentNode as HTMLElement) {
        if (dom.nodeName == "LI" && (match = /-(\d+)$/.exec(dom.id)) && +match[1] < options.length) {
          applyCompletion(view, options[+match[1]])
          e.preventDefault()
          return
        }
      }
    })
    this.list = this.dom.appendChild(this.createListBox(options, cState.id, this.range))
    this.list.addEventListener("scroll", () => {
      if (this.info) this.view.requestMeasure(this.placeInfo)
    })
  }

  mount() { this.updateSel() }

  update(update: ViewUpdate) {
    if (update.state.field(this.stateField) != update.startState.field(this.stateField))
      this.updateSel()
  }

  positioned() {
    if (this.info) this.view.requestMeasure(this.placeInfo)
  }

  updateSel() {
    let cState = this.view.state.field(this.stateField), open = cState.open!
    if (open.selected < this.range.from || open.selected >= this.range.to) {
      this.range = rangeAroundSelected(open.options.length, open.selected,
                                       this.view.state.facet(completionConfig).maxRenderedOptions)
      this.list.remove()
      this.list = this.dom.appendChild(this.createListBox(open.options, cState.id, this.range))
      this.list.addEventListener("scroll", () => {
        if (this.info) this.view.requestMeasure(this.placeInfo)
      })
    }

    if (this.updateSelectedOption(open.selected)) {
      if (this.info) {this.info.remove(); this.info = null}
      let option = open.options[open.selected]
      if (option.completion.info) {
        this.info = this.dom.appendChild(createInfoDialog(option, this.view)) as HTMLElement
        this.view.requestMeasure(this.placeInfo)
      }
    }
  }

  updateSelectedOption(selected: number) {
    let set: null | HTMLElement = null
    for (let opt = this.list.firstChild as (HTMLElement | null), i = this.range.from; opt;
         opt = opt.nextSibling as (HTMLElement | null), i++) {
      if (i == selected) {
        if (!opt.hasAttribute("aria-selected")) {
          opt.setAttribute("aria-selected", "true")
          set = opt
        }
      } else {
        if (opt.hasAttribute("aria-selected")) opt.removeAttribute("aria-selected")
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
    if (selRect.top > Math.min(innerHeight, listRect.bottom) - 10 || selRect.bottom < Math.max(0, listRect.top) + 10)
      return null
    let top = Math.max(0, Math.min(selRect.top, innerHeight - infoRect.height)) - listRect.top
    let left = this.view.textDirection == Direction.RTL
    let spaceLeft = listRect.left, spaceRight = innerWidth - listRect.right
    if (left && spaceLeft < Math.min(infoRect.width, spaceRight)) left = false
    else if (!left && spaceRight < Math.min(infoRect.width, spaceLeft)) left = true
    return {top, left}
  }

  positionInfo(pos: {top: number, left: boolean} | null) {
    if (this.info) {
      this.info.style.top = (pos ? pos.top : -1e6) + "px"
      if (pos) {
        this.info.classList.toggle("cm-completionInfo-left", pos.left)
        this.info.classList.toggle("cm-completionInfo-right", !pos.left)
      }
    }
  }

  createListBox(options: readonly Option[], id: string, range: {from: number, to: number}) {
    const ul = document.createElement("ul")
    ul.id = id
    ul.setAttribute("role", "listbox")
    ul.setAttribute("aria-expanded", "true")
    for (let i = range.from; i < range.to; i++) {
      let {completion, match} = options[i]
      const li = ul.appendChild(document.createElement("li"))
      li.id = id + "-" + i
      li.setAttribute("role", "option")
      let cls = this.optionClass(completion)
      if (cls) li.className = cls
      for (let source of this.optionContent) {
        let node = source(completion, this.view.state, match)
        if (node) li.appendChild(node)
      }
    }
    if (range.from) ul.classList.add("cm-completionListIncompleteTop")
    if (range.to < options.length) ul.classList.add("cm-completionListIncompleteBottom")
    return ul
  }
}

// We allocate a new function instance every time the completion
// changes to force redrawing/repositioning of the tooltip
export function completionTooltip(stateField: StateField<CompletionState>) {
  return (view: EditorView): TooltipView => new CompletionTooltip(view, stateField)
}

function scrollIntoView(container: HTMLElement, element: HTMLElement) {
  let parent = container.getBoundingClientRect()
  let self = element.getBoundingClientRect()
  if (self.top < parent.top) container.scrollTop -= parent.top - self.top
  else if (self.bottom > parent.bottom) container.scrollTop += self.bottom - parent.bottom
}
