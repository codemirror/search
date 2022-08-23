import {SearchQuery} from "@codemirror/search"
import {Text} from "@codemirror/state"
import ist from "ist"

function test(query: SearchQuery, doc: string) {
  let matches = [], m
  while (m = /\[([^]*?)\]/.exec(doc)) {
    matches.push([m.index, m.index + m[1].length])
    doc = doc.slice(0, m.index) + m[1] + doc.slice(m.index + m[0].length)
  }
  let text = Text.of(doc.split("\n"))
  let cursor = query.getCursor(text), found = []
  for (let v; !(v = cursor.next()).done;) found.push([v.value.from, v.value.to])
  ist(JSON.stringify(found), JSON.stringify(matches))
}

describe("SearchQuery", () => {
  it("can match plain strings", () => {
    test(new SearchQuery({search: "abc"}), "[abc] flakdj a[abc] aabbcc")
  })

  it("skips overlapping matches", () => {
    test(new SearchQuery({search: "aba"}), "[aba]b[aba].")
  })

  it("can match case-insensitive strings", () => {
    test(new SearchQuery({search: "abC", caseSensitive: false}), "[aBc] flakdj a[ABC]")
  })

  it("can match across lines", () => {
    test(new SearchQuery({search: "a\\nb"}), "a [a\nb] b")
  })

  it("can match across multiple lines", () => {
    test(new SearchQuery({search: "a\\nb\\nc\\nd"}), "a [a\nb\nc\nd] e")
  })
  
  it("can match literally", () => {
    test(new SearchQuery({search: "a\\nb", literal: true}), "a\nb [a\\nb]")
  })

  it("can match by word", () => {
    test(new SearchQuery({search: "hello", wholeWord: true}), "[hello] hellothere [hello]\nello ahello ohellop")
  })

  it("doesn't match non-words by word", () => {
    test(new SearchQuery({search: "^_^", wholeWord: true}), "x[^_^]y [^_^]")
  })

  it("can match regular expressions", () => {
    test(new SearchQuery({search: "a..b", regexp: true}), "[appb] apb")
  })

  it("can match case-insensitive regular expressions", () => {
    test(new SearchQuery({search: "a..b", regexp: true, caseSensitive: false}), "[Appb] Apb")
  })

  it("can match regular expressions by word", () => {
    test(new SearchQuery({search: "a..", regexp: true, wholeWord: true}), "[aap] baap aapje [a--]w")
  })
})
