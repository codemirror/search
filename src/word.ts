import {CharCategory, EditorState} from "@codemirror/state";

// Whether the characters directly outside the given positions are non-word characters
export function insideWordBoundaries (check: (char: string) => CharCategory, state: EditorState, from: number, to: number): boolean {
    return (from == 0 || check(state.sliceDoc(from - 1, from)) != CharCategory.Word) &&
        (to == state.doc.length || check(state.sliceDoc(to, to + 1)) != CharCategory.Word)
}

// Whether the characters directly at the given positions are word characters
export function insideWord (check: (char: string) => CharCategory, state: EditorState, from: number, to: number): boolean {
    return check(state.sliceDoc(from, from + 1)) == CharCategory.Word
        && check(state.sliceDoc(to - 1, to)) == CharCategory.Word
}

/// Whether the characters at the end of the given range are word characters inside non-word characters
export function isWholeWord (check: (char: string) => CharCategory, state: EditorState, from: number, to: number): boolean {
    return insideWordBoundaries(check, state, from, to)
        && insideWord(check, state, from, to)
}
