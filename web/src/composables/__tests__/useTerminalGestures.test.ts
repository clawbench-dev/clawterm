import { describe, expect, it } from 'vitest'
import {
  clientXToViewportCol,
  clientYToViewportRow,
  selectionCellsToSelect,
} from '../useTerminalGestures'

describe('clientYToViewportRow', () => {
  it('maps a coordinate inside the container to its row', () => {
    // 20px cells starting at y=100: y=100 → row 0, y=139 → row 1.
    expect(clientYToViewportRow(100, 100, 20, 24)).toBe(0)
    expect(clientYToViewportRow(119, 100, 20, 24)).toBe(0)
    expect(clientYToViewportRow(120, 100, 20, 24)).toBe(1)
    expect(clientYToViewportRow(139, 100, 20, 24)).toBe(1)
  })

  // A drag can leave the terminal: the last row is the honest answer, and it
  // must not be negative or past the viewport.
  it('clamps above and below the viewport', () => {
    expect(clientYToViewportRow(0, 100, 20, 24)).toBe(0)
    expect(clientYToViewportRow(9999, 100, 20, 24)).toBe(23)
  })

  // Before the first layout pass the cell size is 0. Dividing by it would give
  // Infinity, which the caller would then pass to xterm.
  it('returns 0 for degenerate metrics', () => {
    expect(clientYToViewportRow(150, 100, 0, 24)).toBe(0)
    expect(clientYToViewportRow(150, 100, 20, 0)).toBe(0)
  })
})

describe('clientXToViewportCol', () => {
  it('maps a coordinate to its column', () => {
    expect(clientXToViewportCol(0, 0, 10, 80)).toBe(0)
    expect(clientXToViewportCol(9, 0, 10, 80)).toBe(0)
    expect(clientXToViewportCol(10, 0, 10, 80)).toBe(1)
  })

  it('clamps to the last column', () => {
    expect(clientXToViewportCol(9999, 0, 10, 80)).toBe(79)
  })

  it('returns 0 for degenerate metrics', () => {
    expect(clientXToViewportCol(50, 0, 0, 80)).toBe(0)
  })
})

describe('selectionCellsToSelect', () => {
  const COLS = 80

  it('selects a single cell', () => {
    expect(selectionCellsToSelect(5, 2, 5, 2, 0, COLS)).toEqual({ col: 5, row: 2, length: 1 })
  })

  // xterm's `select` is exclusive of the end cell, so a range from col 3 to
  // col 7 is 5 cells, not 4.
  it('includes the end cell in the length', () => {
    expect(selectionCellsToSelect(3, 0, 7, 0, 0, COLS)).toEqual({ col: 3, row: 0, length: 5 })
  })

  it('spans rows using the column count', () => {
    // row 0 col 78 → row 1 col 1: 2 cells to the end of row 0, then 2 in row 1.
    expect(selectionCellsToSelect(78, 0, 1, 1, 0, COLS)).toEqual({ col: 78, row: 0, length: 4 })
  })

  // A drag can run backwards. The result must be normalized earlier-first, or
  // xterm selects the wrong region (or nothing).
  it('normalizes a backward drag', () => {
    const forward = selectionCellsToSelect(3, 1, 7, 1, 0, COLS)
    const backward = selectionCellsToSelect(7, 1, 3, 1, 0, COLS)
    expect(backward).toEqual(forward)
  })

  it('normalizes a backward multi-row drag', () => {
    const forward = selectionCellsToSelect(10, 1, 20, 3, 0, COLS)
    const backward = selectionCellsToSelect(20, 3, 10, 1, 0, COLS)
    expect(backward).toEqual(forward)
  })

  // The viewport is scrolled: the selection must be expressed in BUFFER rows,
  // not viewport rows, or it lands on whatever is currently at the top.
  it('adds the scroll offset to the row', () => {
    const top = selectionCellsToSelect(0, 0, 0, 0, 0, COLS)
    const scrolled = selectionCellsToSelect(0, 0, 0, 0, 500, COLS)
    expect(top.row).toBe(0)
    expect(scrolled.row).toBe(500)
  })
})
