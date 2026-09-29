import { describe, expect, it } from 'vitest'
import { countNodes, countVisibleNodes, pruneTree } from './tree.js'

/** A three-level outline: root -> a -> a1/a2, plus one sibling and a shadow root. */
const outline = {
  tag: 'body',
  visible: true,
  children: [
    { tag: 'div', visible: true, children: [{ tag: 'span', visible: false, children: [] }] },
    { tag: 'div', visible: false, children: [] },
  ],
  shadowRoot: [{ tag: 'custom-el', visible: true, children: [] }],
}

describe('pruneTree', () => {
  it('keeps the root and drops every descendant at depth 0', () => {
    const pruned = pruneTree(outline, 0)
    expect(pruned.tag).toBe('body')
    expect(pruned.children).toBeUndefined()
    expect(pruned.shadowRoot).toBeUndefined()
  })

  it('keeps one level of children at depth 1', () => {
    const pruned = pruneTree(outline, 1)
    expect(pruned.children).toHaveLength(2)
    expect(pruned.children[0].tag).toBe('div')
    expect(pruned.children[0].children).toBeUndefined()
  })

  it('prunes shadow roots as well as children', () => {
    const pruned = pruneTree(outline, 1)
    expect(pruned.shadowRoot[0].tag).toBe('custom-el')
    expect(pruned.shadowRoot[0].children).toBeUndefined()
  })

  it('leaves the input untouched', () => {
    pruneTree(outline, 1)
    expect(outline.children[0].children).toHaveLength(1)
  })

  it('passes non-objects through and defaults a missing depth to 0', () => {
    expect(pruneTree(null, 3)).toBeNull()
    expect(pruneTree('x', 3)).toBe('x')
    expect(pruneTree(outline).children).toBeUndefined()
  })
})

describe('countNodes', () => {
  it('counts the root, children, and shadow roots', () => {
    // body + 2 divs + 1 span + 1 custom-el
    expect(countNodes(outline)).toBe(5)
  })

  it('counts nothing for a missing tree', () => {
    expect(countNodes(undefined)).toBe(0)
  })
})

describe('countVisibleNodes', () => {
  it('counts only nodes the extension marked visible', () => {
    expect(countVisibleNodes(outline)).toBe(3)
  })
})
