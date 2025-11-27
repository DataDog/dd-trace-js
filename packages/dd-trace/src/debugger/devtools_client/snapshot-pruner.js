'use strict'

/**
 * This module provides functionality to intelligently prune oversized JSON snapshots by selectively removing the
 * largest and deepest leaf nodes while preserving the schema structure.
 */

// The RFC specifies that we should prune nodes at level 5 or deeper, but the Node.js implementation has an extra level
// of depth because it doesn't use the compound key `debugger.snapshot`, but individual `debugger` and `snapshot` keys,
// so we prune at level 6 or deeper. This level contains the `locals` key.
const MIN_PRUNE_LEVEL = 6
const PRUNED_JSON = '{"pruned":true}'
const PRUNED_JSON_BYTES = Buffer.byteLength(PRUNED_JSON)

module.exports = { pruneSnapshot }

/**
 * Tree node representing a JSON object in the parsed structure
 */
class TreeNode {
  /** @type {number} End position in JSON string (set when object closes) */
  end = -1
  /** @type {TreeNode[]} Child nodes */
  children = []
  /** @type {boolean} Has notCapturedReason: "depth" */
  notCapturedDepth = false
  /** @type {boolean} Has any notCapturedReason */
  notCaptured = false
  /** @type {number} Cached byte size */
  #sizeCache = -1

  /**
   * @param {number} start - Start position in JSON string
   * @param {number} level - Depth in tree (root = 0)
   * @param {string} json - Reference to original JSON string
   * @param {TreeNode|null} [parent] - Parent node reference
   */
  constructor (start, level, json, parent = null) {
    /** @type {number} Start position in JSON string */
    this.start = start
    /** @type {number} Depth in tree (root = 0) */
    this.level = level
    /** @type {string} Reference to original JSON string */
    this.json = json
    /** @type {TreeNode|null} Parent node reference */
    this.parent = parent
  }

  get size () {
    if (this.#sizeCache === -1) {
      if (this.end === -1) {
        throw new Error('Cannot get size: node.end has not been set yet')
      }
      this.#sizeCache = Buffer.byteLength(this.json.slice(this.start, this.end + 1))
    }
    return this.#sizeCache
  }

  get isLeaf () {
    return this.children.length === 0
  }

  /**
   * Priority key for sorting in queue (higher values = higher priority for pruning). Checks ancestors for
   * `notCapturedReason` flags to prioritize children of partially captured objects (where the flag is on the parent).
   *
   * @returns {[number, number, number, number]} Priority key tuple: [not_captured_depth, level, not_captured, size]
   */
  get priorityKey () {
    let hasNotCapturedDepth = this.notCapturedDepth
    let hasNotCaptured = this.notCaptured

    // Check ancestors for notCapturedReason flags
    let ancestor = this.parent
    while (ancestor) {
      if (ancestor.notCapturedDepth) hasNotCaptured = hasNotCapturedDepth = true
      else if (ancestor.notCaptured) hasNotCaptured = true
      ancestor = ancestor.parent
    }

    return [
      hasNotCapturedDepth ? 1 : 0,
      this.level,
      hasNotCaptured ? 1 : 0,
      this.size
    ]
  }
}

/**
 * Priority queue implementation using a binary heap.
 * Items with higher priority (by priorityKey) are popped first.
 */
class PriorityQueue {
  /** @type {TreeNode[]} Binary heap of nodes */
  #heap = []

  push (node) {
    this.#heap.push(node)
    this.#bubbleUp(this.#heap.length - 1)
  }

  pop () {
    if (this.#heap.length === 0) return
    if (this.#heap.length === 1) return /** @type {TreeNode} */ (this.#heap.pop())

    const top = this.#heap[0]
    this.#heap[0] = /** @type {TreeNode} */ (this.#heap.pop())
    this.#bubbleDown(0)
    return top
  }

  get size () {
    return this.#heap.length
  }

  #bubbleUp (index) {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2)
      if (this.#compare(this.#heap[index], this.#heap[parentIndex]) <= 0) break

      [this.#heap[index], this.#heap[parentIndex]] = [this.#heap[parentIndex], this.#heap[index]]
      index = parentIndex
    }
  }

  #bubbleDown (index) {
    while (true) {
      let largest = index
      const leftChild = 2 * index + 1
      const rightChild = 2 * index + 2

      if (leftChild < this.#heap.length && this.#compare(this.#heap[leftChild], this.#heap[largest]) > 0) {
        largest = leftChild
      }
      if (rightChild < this.#heap.length && this.#compare(this.#heap[rightChild], this.#heap[largest]) > 0) {
        largest = rightChild
      }

      if (largest === index) break

      [this.#heap[index], this.#heap[largest]] = [this.#heap[largest], this.#heap[index]]
      index = largest
    }
  }

  /**
   * Compare two nodes by their priority keys.
   *
   * @param {TreeNode} a - First node to compare
   * @param {TreeNode} b - Second node to compare
   * @returns {number} - > 0 if a has higher priority, < 0 if b has higher priority, 0 if equal
   */
  #compare (a, b) {
    const keyA = a.priorityKey
    const keyB = b.priorityKey
    for (let i = 0; i < 4; i++) {
      if (keyA[i] !== keyB[i]) {
        return keyA[i] - keyB[i]
      }
    }
    return 0
  }
}

/**
 * Parse JSON string and build a tree of objects with position tracking.
 * Also detects notCapturedReason properties to set node flags.
 *
 * @param {string} json - The JSON string to parse
 * @returns {TreeNode|null} The root node of the tree, or null if parsing fails
 */
function parseJsonToTree (json) {
  /** @type {TreeNode[]} Stack of nodes */
  const stack = []
  /** @type {TreeNode|null} The root node of the tree, or null if parsing fails */
  let root = null
  let depth = 0

  for (let index = 0; index < json.length; index++) {
    switch (json.charCodeAt(index)) {
      case 34: // 34: double quote
        // Skip strings to avoid false positives
        index = skipString(json, index)
        break
      case 123: { // 123: opening brace
        const parentNode = stack.at(-1)
        const level = depth
        const node = new TreeNode(index, level, json, parentNode)

        if (parentNode) {
          parentNode.children.push(node)
        } else {
          root = node
        }

        stack.push(node)
        depth++
        break
      }
      case 125: { // 125: closing brace
        const node = stack.pop()
        if (node === undefined) throw new SyntaxError('Invalid JSON: unexpected closing brace')
        node.end = index

        const notCapturedReason = findNotCapturedReason(node)
        if (notCapturedReason) {
          node.notCaptured = true
          if (notCapturedReason === 'depth') {
            node.notCapturedDepth = true
          }
        }
        depth--
        break
      }
    }
  }

  return root
}

/**
 * Skip to the end of a JSON string, properly handling escape sequences.
 *
 * @param {string} json - The JSON string to skip
 * @param {number} startIndex - The index to start skipping from
 * @returns {number} The index of the closing quote
 */
function skipString (json, startIndex) {
  let index = startIndex + 1 // Skip opening quote

  while (index < json.length) {
    const code = json.charCodeAt(index)

    if (code === 92) { // 92: backslash
      // Skip the backslash and the next character (whatever it is)
      index += 2
      continue
    }

    if (code === 34) { // 34: double quote
      // Found unescaped closing quote
      return index
    }

    index++
  }

  return index
}

/**
 * Find notCapturedReason value in a JSON object string.
 *
 * @param {TreeNode} node - The node to search in
 * @returns {string|undefined} The reason value or undefined if not found
 */
function findNotCapturedReason (node) {
  let { json, start: index, end, children } = node
  let childIndex = 0

  while (true) {
    // Skip children logic: if current position overlaps with next child, jump over it
    if (childIndex < children.length) {
      const child = children[childIndex]
      // If we are at or past the start of the current child
      if (index >= child.start) {
        // Skip to the end of the child
        index = child.end + 1
        childIndex++
        continue
      }
    }

    // Find the next string
    const nextQuote = json.indexOf('"', index)
    // If no more strings, stop
    if (nextQuote === -1 || nextQuote >= end) return

    // Skip over any children that come before or contain the found quote
    let quoteIsInsideChild = false
    while (childIndex < children.length) {
      const child = children[childIndex]
      if (nextQuote > child.end) {
        // Quote is after this child, skip it
        childIndex++
        continue
      }
      if (nextQuote >= child.start && nextQuote <= child.end) {
        // Quote is inside this child, skip to end of child and restart outer loop
        index = child.end + 1
        childIndex++
        quoteIsInsideChild = true
        break
      }
      // Quote is before this child, so it's valid at current level
      break
    }

    // If the quote was inside a child, restart the outer loop
    if (quoteIsInsideChild) continue

    // Valid quote at current level
    index = nextQuote

    const stringStart = index + 1 // Skip opening quote
    index = skipString(json, index)

    if (json.slice(stringStart, index) === 'notCapturedReason') {
      // Found the potential property name, now see if it has a value and if so, return it
      index++ // Skip closing quote

      let code

      // Skip whitespace and colon
      while (true) {
        if (index >= end) return
        code = json.charCodeAt(index)
        // 32: space, 9: tab, 10: newline, 13: carriage return, 58: colon
        if (code === 32 || code === 9 || code === 10 || code === 13 || code === 58) {
          index++
        } else {
          break
        }
      }

      // If next character is a quote, `notCapturedReason` must have been a property name, and now we're at the value
      if (code === 34) { // 34: double quote
        const valueStart = index + 1 // Skip opening quote
        index = skipString(json, index)
        return json.slice(valueStart, index)
      }
    }

    index++
  }
}

/**
 * Collect all leaf nodes at MIN_PRUNE_LEVEL or deeper.
 *
 * @param {TreeNode} root - The root node of the tree
 * @returns {TreeNode[]} The array of leaf nodes
 */
function collectPrunableLeaves (root) {
  const leaves = []

  function traverse (node) {
    if (!node) return

    if (node.isLeaf && node.level >= MIN_PRUNE_LEVEL) {
      leaves.push(node)
    }

    for (const child of node.children) {
      traverse(child)
    }
  }

  traverse(root)
  return leaves
}

/**
 * Select nodes to prune using the priority queue algorithm.
 *
 * @param {TreeNode} root - The root node of the tree
 * @param {number} bytesToRemove - The number of bytes to remove
 * @returns {Set<TreeNode>} The set of nodes marked for pruning
 */
function selectNodesToPrune (root, bytesToRemove) {
  const queue = new PriorityQueue()
  const prunedNodes = new Set()
  const promotedParents = new Set()

  // Collect initial leaf nodes
  const leaves = collectPrunableLeaves(root)
  for (const leaf of leaves) {
    queue.push(leaf)
  }

  let bytesRemoved = 0

  while (queue.size > 0 && bytesRemoved < bytesToRemove) {
    const node = /** @type {TreeNode} */ (queue.pop())

    if (prunedNodes.has(node)) continue
    prunedNodes.add(node)

    bytesRemoved += node.size - PRUNED_JSON_BYTES

    // Check if parent should be promoted to leaf
    const parent = node.parent
    if (parent && parent.level >= MIN_PRUNE_LEVEL && !promotedParents.has(parent)) {
      // Check if all children are now pruned
      const allChildrenPruned = parent.children.every(child => prunedNodes.has(child))

      if (allChildrenPruned) {
        // Unmark all children as pruned (parent will represent them)
        for (const child of parent.children) {
          prunedNodes.delete(child)
          bytesRemoved -= child.size - PRUNED_JSON_BYTES
        }

        // Promote parent to leaf by marking it with notCapturedDepth flag
        parent.notCaptured = true
        parent.notCapturedDepth = true
        promotedParents.add(parent)

        // Add parent to queue for potential pruning
        queue.push(parent)
      }
    }
  }

  return prunedNodes
}

/**
 * Rebuild JSON string with pruned nodes replaced by {"pruned":true}
 *
 * @param {string} json - The JSON string to rebuild
 * @param {Set<TreeNode>} prunedNodes - The set of nodes to replace with {"pruned":true}
 * @returns {string} The rebuilt JSON string
 */
function rebuildJson (json, prunedNodes) {
  // Convert set to array and sort by start position (descending)
  const sortedNodes = [...prunedNodes].sort((a, b) => b.start - a.start)

  // Replace from end to start to maintain position indices
  for (const node of sortedNodes) {
    const before = json.slice(0, node.start)
    const after = json.slice(node.end + 1)
    json = before + PRUNED_JSON + after
  }

  return json
}

/**
 * Main pruning function
 *
 * @param {string} json - The JSON string to prune
 * @param {number} originalSize - Size of the original JSON string in bytes
 * @param {number} maxSize - Maximum allowed size in bytes
 * @returns {string|undefined} - Pruned JSON string, or undefined if pruning fails
 */
function pruneSnapshot (json, originalSize, maxSize) {
  const bytesToRemove = originalSize - maxSize

  if (bytesToRemove <= 0) return json // No pruning needed

  let prunedSize = originalSize
  let attempts = 0
  const maxAttempts = 6

  while (prunedSize > maxSize && attempts < maxAttempts) {
    attempts++

    const root = parseJsonToTree(json)
    if (!root) break

    const targetBytesToRemove = prunedSize - maxSize
    const prunedNodes = selectNodesToPrune(root, targetBytesToRemove)
    if (prunedNodes.size === 0) break

    json = rebuildJson(json, prunedNodes)
    prunedSize = Buffer.byteLength(json)
  }

  // If pruning didn't help, return undefined
  return prunedSize >= originalSize ? undefined : json
}
