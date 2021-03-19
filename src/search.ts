import {EditorView, ViewPlugin, ViewUpdate, Command, Decoration, DecorationSet,
        runScopeHandlers, KeyBinding} from "@codemirror/view"
import {StateField, StateEffect, EditorSelection, StateCommand, Prec} from "@codemirror/state"
import {PanelConstructor, showPanel, getPanel} from "@codemirror/panel"
import {Text} from "@codemirror/text"
import {RangeSetBuilder} from "@codemirror/rangeset"
import elt from "crelt"
import {SearchCursor} from "./cursor"
import {RegExpCursor, validRegExp} from "./regexp"
import {gotoLine} from "./goto-line"

export {highlightSelectionMatches} from "./selection-match"
export {SearchCursor, RegExpCursor, gotoLine}

type SearchResult = typeof SearchCursor.prototype.value

abstract class Query<Result extends SearchResult = SearchResult> {
  constructor(readonly search: string,
              readonly replace: string,
              readonly caseInsensitive: boolean) {}

  eq(other: Query) {
    return this.search == other.search && this.replace == other.replace &&
      this.caseInsensitive == other.caseInsensitive && this.constructor == other.constructor
  }

  abstract valid: boolean

  abstract nextMatch(doc: Text, curFrom: number, curTo: number): Result | null

  abstract prevMatch(doc: Text, curFrom: number, curTo: number): Result | null

  abstract getReplacement(result: Result): string

  abstract matchAll(doc: Text, limit: number): readonly Result[] | null

  abstract highlight(doc: Text, from: number, to: number, add: (from: number, to: number) => void): void
}

const enum FindPrev { ChunkSize = 10000 }

// FIXME resolve \n etc in input string. Check what CM5 is doing there.
class StringQuery extends Query<SearchResult> {
  private cursor(doc: Text, from = 0, to = doc.length) {
    return new SearchCursor(doc, this.search, from, to, this.caseInsensitive ? x => x.toLowerCase() : undefined)
  }

  nextMatch(doc: Text, curFrom: number, curTo: number) {
    let cursor = this.cursor(doc, curTo).nextOverlapping()
    if (cursor.done) cursor = this.cursor(doc, 0, curFrom).nextOverlapping()
    return cursor.done ? null : cursor.value
  }

  // Searching in reverse is, rather than implementing inverted search
  // cursor, done by scanning chunk after chunk forward.
  private prevMatchInRange(doc: Text, from: number, to: number) {
    for (let pos = to;;) {
      let start = Math.max(from, pos - FindPrev.ChunkSize - this.search.length)
      let cursor = this.cursor(doc, start, pos), range: {from: number, to: number} | null = null
      while (!cursor.nextOverlapping().done) range = cursor.value
      if (range) return range
      if (start == from) return null
      pos -= FindPrev.ChunkSize
    }
  }

  prevMatch(doc: Text, curFrom: number, curTo: number) {
    return this.prevMatchInRange(doc, 0, curFrom) ||
      this.prevMatchInRange(doc, curTo, doc.length)
  }

  // FIXME splicing of $1?
  getReplacement(_result: SearchResult) { return this.replace }

  matchAll(doc: Text, limit: number) {
    let cursor = this.cursor(doc), ranges = []
    while (!cursor.next().done) {
      if (ranges.length >= limit) return null
      ranges.push(cursor.value)
    }
    return ranges
  }

  highlight(doc: Text, from: number, to: number, add: (from: number, to: number) => void) {
    let cursor = this.cursor(doc, Math.max(0, from - this.search.length),
                             Math.min(to + this.search.length, doc.length))
    while (!cursor.next().done) add(cursor.value.from, cursor.value.to)
  }

  get valid() { return !!this.search }
}

const enum RegExp { HighlightMargin = 250 }

type RegExpResult = typeof RegExpCursor.prototype.value

class RegExpQuery extends Query<RegExpResult> {
  valid: boolean

  constructor(search: string, replace: string, caseInsensitive: boolean) {
    super(search, replace, caseInsensitive)
    this.valid = !!search && validRegExp(search)
  }

  private cursor(doc: Text, from: number = 0, to: number = doc.length) {
    return new RegExpCursor(doc, this.search, this.caseInsensitive ? {ignoreCase: true} : undefined, from, to)
  }

  nextMatch(doc: Text, curFrom: number, curTo: number) {
    let cursor = this.cursor(doc, curTo).nextOverlapping()
    if (cursor.done) cursor = this.cursor(doc, 0, curFrom).nextOverlapping()
    return cursor.done ? null : cursor.value
  }

  prevMatch(doc: Text, curFrom: number, curTo: number) {
    return null
  }

  getReplacement(result: RegExpResult) {
    return this.replace.replace(/\$([$&\d+])/g, (m, i) =>
      i == "$" ? "$"
      : i == "&" ? result.match[0]
      : i != "0" && +i < result.match.length ? result.match[i]
      : m)
  }

  matchAll(doc: Text, limit: number) {
    let cursor = this.cursor(doc), ranges = []
    while (!cursor.nextOverlapping().done) {
      if (ranges.length >= limit) return null
      ranges.push(cursor.value)
    }
    return ranges
  }

  highlight(doc: Text, from: number, to: number, add: (from: number, to: number) => void) {
    let cursor = this.cursor(doc, Math.max(0, from - RegExp.HighlightMargin),
                             Math.min(to + RegExp.HighlightMargin, doc.length))
    while (!cursor.nextOverlapping().done) add(cursor.value.from, cursor.value.to)
  }
}

const setQuery = StateEffect.define<Query>()

const togglePanel = StateEffect.define<boolean>()

const searchState: StateField<SearchState> = StateField.define<SearchState>({
  create() {
    return new SearchState(new StringQuery("", "", false), null)
  },
  update(value, tr) {
    for (let effect of tr.effects) {
      if (effect.is(setQuery)) value = new SearchState(effect.value, value.panel)
      else if (effect.is(togglePanel)) value = new SearchState(value.query, effect.value ? createSearchPanel : null)
    }
    return value
  },
  provide: f => showPanel.from(f, val => val.panel)
})

class SearchState {
  constructor(readonly query: Query, readonly panel: PanelConstructor | null) {}
}

const matchMark = Decoration.mark({class: "cm-searchMatch"}),
      selectedMatchMark = Decoration.mark({class: "cm-searchMatch cm-searchMatch-selected"})

const searchHighlighter = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor(readonly view: EditorView) {
    this.decorations = this.highlight(view.state.field(searchState))
  }

  update(update: ViewUpdate) {
    let state = update.state.field(searchState)
    if (state != update.startState.field(searchState) || update.docChanged || update.selectionSet)
      this.decorations = this.highlight(state)
  }

  highlight({query, panel}: SearchState) {
    if (!panel || !query.valid) return Decoration.none
    let {view} = this
    let builder = new RangeSetBuilder<Decoration>()
    for (let i = 0, ranges = view.visibleRanges, l = ranges.length; i < l; i++) {
      let {from, to} = ranges[i]
      while (i < l - 1 && to > ranges[i + 1].from - RegExp.HighlightMargin) to = ranges[++i].to
      query.highlight(view.state.doc, from, to, (from, to) => {
        let selected = view.state.selection.ranges.some(r => r.from == from && r.to == to)
        builder.add(from, to, selected ? selectedMatchMark : matchMark)
      })
    }
    return builder.finish()
  }
}, {
  decorations: v => v.decorations
})

function searchCommand(f: (view: EditorView, state: SearchState) => boolean): Command {
  return view => {
    let state = view.state.field(searchState, false)
    return state && state.query.valid ? f(view, state) : openSearchPanel(view)
  }
}

/// Open the search panel if it isn't already open, and move the
/// selection to the first match after the current main selection.
/// Will wrap around to the start of the document when it reaches the
/// end.
export const findNext = searchCommand((view, {query}) => {
  let {from, to} = view.state.selection.main
  let next = query.nextMatch(view.state.doc, from, to)
  if (!next || next.from == from && next.to == to) return false
  view.dispatch({
    selection: {anchor: next.from, head: next.to},
    scrollIntoView: true,
    effects: announceMatch(view, next)
  })
  return true
})

/// Move the selection to the previous instance of the search query,
/// before the current main selection. Will wrap past the start
/// of the document to start searching at the end again.
export const findPrevious = searchCommand((view, {query}) => {
  let {state} = view, {from, to} = state.selection.main
  let range = query.prevMatch(state.doc, from, to)
  if (!range) return false
  view.dispatch({
    selection: {anchor: range.from, head: range.to},
    scrollIntoView: true,
    effects: announceMatch(view, range)
  })
  return true
})

/// Select all instances of the search query.
export const selectMatches = searchCommand((view, {query}) => {
  let ranges = query.matchAll(view.state.doc, 1000)
  if (!ranges || !ranges.length) return false
  view.dispatch({
    selection: EditorSelection.create(ranges.map(r => EditorSelection.range(r.from, r.to)))
  })
  return true
})

/// Select all instances of the currently selected text.
export const selectSelectionMatches: StateCommand = ({state, dispatch}) => {
  let sel = state.selection
  if (sel.ranges.length > 1 || sel.main.empty) return false
  let {from, to} = sel.main
  let ranges = [], main = 0
  for (let cur = new SearchCursor(state.doc, state.sliceDoc(from, to)); !cur.next().done;) {
    if (ranges.length > 1000) return false
    if (cur.value.from == from) main = ranges.length
    ranges.push(EditorSelection.range(cur.value.from, cur.value.to))
  }
  dispatch(state.update({selection: EditorSelection.create(ranges, main)}))
  return true
}

/// Replace the current match of the search query.
export const replaceNext = searchCommand((view, {query}) => {
  let {state} = view, {from, to} = state.selection.main
  let next = query.nextMatch(state.doc, from, from)
  if (!next) return false
  let changes = [], selection: {anchor: number, head: number} | undefined, replacement: string | undefined
  if (next.from == from && next.to == to) {
    replacement = state.toText(query.getReplacement(next))
    changes.push({from: next.from, to: next.to, insert: replacement})
    next = query.nextMatch(state.doc, next.from, next.to)
  }
  if (next) {
    let off = changes.length == 0 || changes[0].from >= next.to ? 0 : next.to - next.from - replacement!.length
    selection = {anchor: next.from - off, head: next.to - off}
  }
  view.dispatch({
    changes, selection,
    scrollIntoView: !!selection,
    effects: next ? announceMatch(view, next) : undefined
  })
  return true
})

/// Replace all instances of the search query with the given
/// replacement.
export const replaceAll = searchCommand((view, {query}) => {
  let changes = query.matchAll(view.state.doc, 1e9)!.map(match => {
    let {from, to} = match
    return {from, to, insert: query.getReplacement(match)}
  })
  if (!changes.length) return false
  view.dispatch({changes})
  return true
})

function createSearchPanel(view: EditorView) {
  let {query} = view.state.field(searchState)
  return {
    dom: buildPanel({
      view,
      query,
      updateQuery(q: Query) {
        if (!query.eq(q)) {
          query = q
          view.dispatch({effects: setQuery.of(query)})
        }
      }
    }),
    mount() {
      ;(this.dom.querySelector("[name=search]") as HTMLInputElement).select()
    },
    pos: 80
  }
}

/// Make sure the search panel is open and focused.
export const openSearchPanel: Command = view => {
  let state = view.state.field(searchState, false)
  if (state && state.panel) {
    let panel = getPanel(view, createSearchPanel)
    if (!panel) return false
    ;(panel.dom.querySelector("[name=search]") as HTMLInputElement).focus()
  } else {
    view.dispatch({effects: [togglePanel.of(true), ...state ? [] : [StateEffect.appendConfig.of(searchExtensions)]]})
  }
  return true
}

/// Close the search panel.
export const closeSearchPanel: Command = view => {
  let state = view.state.field(searchState, false)
  if (!state || !state.panel) return false
  let panel = getPanel(view, createSearchPanel)
  if (panel && panel.dom.contains(view.root.activeElement)) view.focus()
  view.dispatch({effects: togglePanel.of(false)})
  return true
}

/// Default search-related key bindings.
///
///  - Mod-f: [`openSearchPanel`](#search.openSearchPanel)
///  - F3, Mod-g: [`findNext`](#search.findNext)
///  - Shift-F3, Shift-Mod-g: [`findPrevious`](#search.findPrevious)
///  - Alt-g: [`gotoLine`](#search.gotoLine)
export const searchKeymap: readonly KeyBinding[] = [
  {key: "Mod-f", run: openSearchPanel, scope: "editor search-panel"},
  {key: "F3", run: findNext, shift: findPrevious, scope: "editor search-panel"},
  {key: "Mod-g", run: findNext, shift: findPrevious, scope: "editor search-panel"},
  {key: "Escape", run: closeSearchPanel, scope: "editor search-panel"},
  {key: "Mod-Shift-l", run: selectSelectionMatches},
  {key: "Alt-g", run: gotoLine}
]

function buildPanel(conf: {
  view: EditorView,
  query: Query,
  updateQuery: (query: Query) => void
}) {
  function phrase(phrase: string) { return conf.view.state.phrase(phrase) }
  let searchField = elt("input", {
    value: conf.query.search,
    placeholder: phrase("Find"),
    "aria-label": phrase("Find"),
    class: "cm-textfield",
    name: "search",
    onchange: update,
    onkeyup: update
  }) as HTMLInputElement
  let replaceField = elt("input", {
    value: conf.query.replace,
    placeholder: phrase("Replace"),
    "aria-label": phrase("Replace"),
    class: "cm-textfield",
    name: "replace",
    onchange: update,
    onkeyup: update
  }) as HTMLInputElement
  let caseField = elt("input", {
    type: "checkbox",
    name: "case",
    checked: !conf.query.caseInsensitive,
    onchange: update
  }) as HTMLInputElement
  let reField = elt("input", {
    type: "checkbox",
    name: "re",
    checked: conf.query instanceof RegExpQuery,
    onchange: update
  }) as HTMLInputElement

  function update() {
    conf.updateQuery(new (reField.checked ? RegExpQuery : StringQuery)(searchField.value, replaceField.value, !caseField.checked))
  }
  function keydown(e: KeyboardEvent) {
    if (runScopeHandlers(conf.view, e, "search-panel")) {
      e.preventDefault()
    } else if (e.keyCode == 13 && e.target == searchField) {
      e.preventDefault()
      ;(e.shiftKey ? findPrevious : findNext)(conf.view)
    } else if (e.keyCode == 13 && e.target == replaceField) {
      e.preventDefault()
      replaceNext(conf.view)
    }
  }
  function button(name: string, onclick: () => void, content: (Node | string)[]) {
    return elt("button", {class: "cm-button", name, onclick}, content)
  }
  let panel = elt("div", {onkeydown: keydown, class: "cm-search"}, [
    searchField,
    button("next", () => findNext(conf.view), [phrase("next")]),
    button("prev", () => findPrevious(conf.view), [phrase("previous")]),
    button("select", () => selectMatches(conf.view), [phrase("all")]),
    elt("label", null, [caseField, phrase("match case")]),
    elt("label", null, [reField, phrase("regexp")]),
    elt("br"),
    replaceField,
    button("replace", () => replaceNext(conf.view), [phrase("replace")]),
    button("replaceAll", () => replaceAll(conf.view), [phrase("replace all")]),
    elt("button", {name: "close", onclick: () => closeSearchPanel(conf.view), "aria-label": phrase("close")}, ["×"])
  ])
  return panel
}

const AnnounceMargin = 30

const Break = /[\s\.,:;?!]/

function announceMatch(view: EditorView, {from, to}: {from: number, to: number}) {
  let lineStart = view.state.doc.lineAt(from).from, lineEnd = view.state.doc.lineAt(to).to
  let start = Math.max(lineStart, from - AnnounceMargin), end = Math.min(lineEnd, to + AnnounceMargin)
  let text = view.state.sliceDoc(start, end)
  if (start != lineStart) {
    for (let i = 0; i < AnnounceMargin; i++) if (!Break.test(text[i + 1]) && Break.test(text[i])) {
      text = text.slice(i)
      break
    }
  }
  if (end != lineEnd) {
    for (let i = text.length - 1; i > text.length - AnnounceMargin; i--) if (!Break.test(text[i - 1]) && Break.test(text[i])) {
      text = text.slice(0, i)
      break
    }
  }

  return EditorView.announce.of(`${view.state.phrase("current match")}. ${text} ${view.state.phrase("on line")} ${
    view.state.doc.lineAt(from).number}`)
}

const baseTheme = EditorView.baseTheme({
  ".cm-panel.cm-search": {
    padding: "2px 6px 4px",
    position: "relative",
    "& [name=close]": {
      position: "absolute",
      top: "0",
      right: "4px",
      backgroundColor: "inherit",
      border: "none",
      font: "inherit",
      padding: 0,
      margin: 0
    },
    "& input, & button, & label": {
      margin: ".2em .6em .2em 0"
    },
    "& input[type=checkbox]": {
      marginRight: ".2em"
    },
    "& label": {
      fontSize: "80%"
    }
  },

  "&light .cm-searchMatch": { backgroundColor: "#ffff0054" },
  "&dark .cm-searchMatch": { backgroundColor: "#00ffff8a" },

  "&light .cm-searchMatch-selected": { backgroundColor: "#ff6a0054" },
  "&dark .cm-searchMatch-selected": { backgroundColor: "#ff00ff8a" }
})

const searchExtensions = [
  searchState,
  Prec.override(searchHighlighter),
  baseTheme
]
