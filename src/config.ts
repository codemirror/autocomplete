import {Completion, CompletionSource} from "./completion"
import {Facet, combineConfig, EditorState} from "@codemirror/state"

export interface CompletionConfig {
  /// When enabled (defaults to true), autocompletion will start
  /// whenever the user types something that can be completed.
  activateOnTyping?: boolean
  /// Override the completion sources used. By default, they will be
  /// taken from the `"autocomplete"` [language
  /// data](#state.EditorState.languageDataAt) (which should hold
  /// [completion sources](#autocomplete.CompletionSource) or arrays
  /// of [completions](#autocomplete.Completion)).
  override?: readonly CompletionSource[] | null,
  /// The maximum number of options to render to the DOM.
  maxRenderedOptions?: number,
  /// Set this to false to disable the [default completion
  /// keymap](#autocomplete.completionKeymap). (This requires you to
  /// add bindings to control completion yourself. The bindings should
  /// probably have a higher precedence than other bindings for the
  /// same keys.)
  defaultKeymap?: boolean,
  /// By default, completions are shown below the cursor when there is
  /// space. Setting this to true will make the extension put the
  /// completions above the cursor when possible.
  aboveCursor?: boolean,
  /// This can be used to add additional CSS classes to completion
  /// options.
  optionClass?: (completion: Completion) => string,
  /// By default, the library will render icons based on the
  /// completion's [type](#autocomplete.Completion.type) in front of
  /// each option. Set this to false to turn that off.
  icons?: boolean,
  /// This option can be used to inject additional content into
  /// options. The `render` function will be called for each visible
  /// completion, and should produce a DOM node to show. `position`
  /// determines where in the DOM the result appears, relative to
  /// other added widgets and the standard content. The default icons
  /// have position 20, the label position 50, and the detail position
  /// 70.
  addToOptions?: {render: (completion: Completion, state: EditorState) => Node | null,
                  position: number}[]
}

export const completionConfig = Facet.define<CompletionConfig, Required<CompletionConfig>>({
  combine(configs) {
    return combineConfig(configs, {
      activateOnTyping: true,
      override: null,
      maxRenderedOptions: 100,
      defaultKeymap: true,
      optionClass: () => "",
      aboveCursor: false,
      icons: true,
      addToOptions: []
    }, {
      defaultKeymap: (a, b) => a && b,
      icons: (a, b) => a && b,
      optionClass: (a, b) => c => joinClass(a(c), b(c)),
      addToOptions: (a, b) => a.concat(b)
    })
  }
})

function joinClass(a: string, b: string) {
  return a ? b ? a + " " + b : a : b
}
