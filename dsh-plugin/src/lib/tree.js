/**
 * Pure helpers for the serialized DOM outline the extension returns. The
 * outline is a plain JSON tree of `{ tag, className, attributes, children,
 * visible, rect }` nodes (plus a `shadowRoot` array on custom elements), so it
 * can be pruned and counted without a DOM.
 * @module dsh-timepass-gemini/lib/tree
 */

/**
 * Copy a node without its child arrays. Used at the depth boundary, where the
 * node's own identity is still useful but its subtree is not.
 *
 * @param {Record<string, unknown>} node - The node to strip.
 * @returns {Record<string, unknown>} A shallow copy without `children` or `shadowRoot`.
 */
function leaf(node) {
  const { children, shadowRoot, ...rest } = node
  return rest
}

/**
 * Prune a serialized subtree to at most `maxDepth` levels below the root.
 *
 * The extension already walks to a fixed depth; this is the tool's own bound,
 * applied on the way back so a caller can ask for a shallow outline without
 * paying for the full one. Depth `0` keeps the root node and drops every
 * descendant.
 *
 * @param {unknown} node - The node to prune, or any non-object value.
 * @param {number} maxDepth - How many levels of children to keep.
 * @returns {unknown} The pruned copy, or the input unchanged when it is not an object.
 */
export function pruneTree(node, maxDepth) {
  if (!node || typeof node !== 'object') return node
  const limit = Number.isFinite(maxDepth) && maxDepth >= 0 ? Math.floor(maxDepth) : 0
  if (limit <= 0) return leaf(node)

  const pruned = { ...node }
  if (Array.isArray(node.children)) {
    pruned.children = node.children.map(child => pruneTree(child, limit - 1)).filter(child => child != null)
  }
  if (Array.isArray(node.shadowRoot)) {
    pruned.shadowRoot = node.shadowRoot.map(child => pruneTree(child, limit - 1)).filter(child => child != null)
  }
  return pruned
}

/**
 * Count every node in a serialized subtree, following both `children` and
 * `shadowRoot` arrays. Iterative so a deep outline cannot overflow the stack.
 *
 * @param {unknown} root - The subtree root.
 * @returns {number} The number of nodes, including the root.
 */
export function countNodes(root) {
  if (!root || typeof root !== 'object') return 0
  let count = 0
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    count += 1
    if (Array.isArray(node.children)) stack.push(...node.children)
    if (Array.isArray(node.shadowRoot)) stack.push(...node.shadowRoot)
  }
  return count
}

/**
 * Count the nodes in a serialized subtree whose `visible` flag is set. The
 * extension sets that flag from layout, so it separates what a reader could
 * actually see from what is merely in the document.
 *
 * @param {unknown} root - The subtree root.
 * @returns {number} The number of visible nodes, including a visible root.
 */
export function countVisibleNodes(root) {
  if (!root || typeof root !== 'object') return 0
  let count = 0
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node.visible) count += 1
    if (Array.isArray(node.children)) stack.push(...node.children)
    if (Array.isArray(node.shadowRoot)) stack.push(...node.shadowRoot)
  }
  return count
}
