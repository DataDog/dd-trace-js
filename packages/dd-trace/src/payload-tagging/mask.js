const GLOB = Symbol('*')

class Mask {
  /**
   * The mask to apply to JSON objects
   *
   * @param {string} filterString
   */
  constructor (filterString) {
    this._root = new MaskNode(
      'root',
      { isSelect: false, isRoot: true }
    )

    for (const rule of this.parsePaths(filterString)) {
      const chain = this.makeChain(rule)
      this._root.addChild(chain)
    }
  }

  /**
   * Split the input according to a given separator, taking into account
   * escaped instances of the separator
   *
   * @param {string} input
   * @param {string} separator
   * @returns {string} an unescaped copy of the input.
   */
  splitUnescape (input, separator) {
    const escapedSep = `\\${separator}`
    const rules = []
    for (let i = 0; i < input.length;) {
      let nextSep = input.indexOf(separator, i)
      while (nextSep >= 0 && input[nextSep - 1] === '\\') {
        nextSep = input.indexOf(separator, nextSep + 1)
      }
      if (nextSep === -1) {
        rules.push(input.substring(i).replaceAll(escapedSep, separator))
        break
      } else {
        rules.push(input.substring(i, nextSep).replaceAll(escapedSep, separator))
        i = nextSep + 1
      }
    }
    return rules
  }

  parsePaths (filterString) {
    return this.splitUnescape(filterString, ',')
  }

  parseKeys (ruleString) {
    return this.splitUnescape(ruleString, '.')
  }

  /**
   * Build a tree representation of a single rule.
   *
   * @param {string} rule
   * @returns {MaskNode} the root node representation of the rule.
   */
  makeChain (rule) {
    const isSelect = !rule.startsWith('-')
    if (!isSelect) {
      rule = rule.substring(1)
    }
    const keys = this.parseKeys(rule)
    const localRoot = new MaskNode(keys.shift(), { isSelect })
    let head = localRoot
    for (const key of keys) {
      head = head.addChild(new MaskNode(key, { isSelect }))
    }
    head.addChild(new MaskNode('*', { isSelect }))
    return localRoot
  }
}

class MaskNode {
  /**
   * A node of the JSON mask tree
   *
   * @param {string} key
   * @param {object} options
   * @param {boolean} options.isSelect
   * @param {boolean} options.isRoot
   */
  constructor (key, { isSelect, isRoot = false }) {
    this.name = key === '*' ? GLOB : key
    this._isSelect = isSelect
    this._children = new Map()
    this._isRoot = isRoot
  }

  get isLeaf () { return this._children.size === 0 }

  get isGlob () { return this.name === GLOB }

  get globChild () { return this.getChild(GLOB) }

  /**
   * Add node as a child of the current node, recursively merging its children
   * if necessary.
   *
   * @param {MaskNode} node
   * @returns {MaskNode} the updated or inserted child node.
   */
  addChild (node) {
    const myChild = this.getChild(node.name)
    if (myChild === undefined) {
      this._children.set(node.name, node)
      return node
    } else {
      for (const child of node._children.values()) {
        myChild.addChild(child)
      }
      return myChild
    }
  }

  /**
   *
   * @param {string} key
   * @returns {MaskNode | undefined}
   */
  getChild (key) { return this._children.get(key) }

  /**
   * Get the child node corresponding to a key in the object we want to mask.
   *
   * @param {string} key
   * @returns {MaskNode | undefined}
   */
  next (key) {
    const nextNode = this.getChild(key)
    if (nextNode === undefined) {
      return this.globChild
    }
    return nextNode
  }

  canTag (key, isLast) {
    const node = this.next(key)
    if (node === undefined) {
      if (this.isGlob && this.isLeaf) {
        return this._isSelect
      }
      if (this._isSelect) {
        // If we are in an including path and we haven't found the tag,
        // then we're not included
        return false
      } else {
        // We're in the root, which should never select anything
        if (this._isRoot) return false
        // Otherwise, we're in an excluding path and we haven't found it,
        // so we're included
        return true
      }
    } else {
      if (isLast || node.isLeaf || (node._children.size === 1 && node.globChild?.isLeaf)) {
        // If we're:
        // * at a leaf
        // * at a terminal glob (that we injected when constructing the tree),
        // * at the last input object key
        // Then we can decide based on node contents.
        return node._isSelect
      }
      // If we're not at the last key or about to hit a leaf, we want to keep going down the tree
      // because the node information may change further down
      return true
    }
  }
}

module.exports = { Mask }
