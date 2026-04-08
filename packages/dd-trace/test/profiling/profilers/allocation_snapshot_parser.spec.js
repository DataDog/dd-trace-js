'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const {
  parseTraceTree,
  parseTraceChildren,
  buildStackKey,
  buildStack,
  parseSnapshot,
} = require('../../../src/profiling/profilers/allocation/snapshot-parser')

require('../../setup/core')

// Minimal function info layout: [?, nameIdx, scriptNameIdx, ?, line, col] × N
// Index 0: root (empty name, empty script, line 0, col 0)
// Index 1: myFunc @ app.js:10:5
// Index 2: helper @ lib.js:20:0
const STRINGS = ['', 'myFunc', 'app.js', 'helper', 'lib.js']
const FUNC_INFOS = [
  0, 0, 0, 0, 0, 0, // fi 0: root (empty)
  0, 1, 2, 0, 10, 5, // fi 1: myFunc @ app.js:10:5
  0, 3, 4, 0, 20, 0, // fi 2: helper @ lib.js:20:0
]

// trace_tree: root(id=1, fi=0) → child(id=2, fi=1, count=5, size=100) → grandchild(id=3, fi=2, count=3, size=60)
const TRACE_TREE = [1, 0, 0, 0, [
  2, 1, 5, 100, [
    3, 2, 3, 60, [],
  ],
]]

describe('snapshot-parser', () => {
  describe('parseTraceTree', () => {
    it('returns empty map for empty input', () => {
      assert.strictEqual(parseTraceTree([]).size, 0)
      assert.strictEqual(parseTraceTree(null).size, 0)
      assert.strictEqual(parseTraceTree(undefined).size, 0)
    })

    it('returns empty map for array shorter than 5 elements', () => {
      assert.strictEqual(parseTraceTree([1, 0, 0, 0]).size, 0)
    })

    it('parses root node only (no children)', () => {
      const tree = [1, 0, 2, 100, []]
      const nodes = parseTraceTree(tree)

      assert.strictEqual(nodes.size, 1)
      assert.deepStrictEqual(nodes.get(1), { functionInfoIndex: 0, parentId: 0, count: 2, size: 100 })
    })

    it('parses root with direct children', () => {
      const nodes = parseTraceTree(TRACE_TREE)

      assert.strictEqual(nodes.size, 3)
      assert.deepStrictEqual(nodes.get(1), { functionInfoIndex: 0, parentId: 0, count: 0, size: 0 })
      assert.deepStrictEqual(nodes.get(2), { functionInfoIndex: 1, parentId: 1, count: 5, size: 100 })
      assert.deepStrictEqual(nodes.get(3), { functionInfoIndex: 2, parentId: 2, count: 3, size: 60 })
    })

    it('correctly links parent ids through multiple levels', () => {
      // root(1) → a(2) → b(3) → c(4)
      const tree = [1, 0, 0, 0, [
        2, 1, 1, 10, [
          3, 2, 2, 20, [
            4, 1, 3, 30, [],
          ],
        ],
      ]]
      const nodes = parseTraceTree(tree)

      assert.strictEqual(nodes.get(2).parentId, 1)
      assert.strictEqual(nodes.get(3).parentId, 2)
      assert.strictEqual(nodes.get(4).parentId, 3)
    })

    it('handles multiple siblings at the same level', () => {
      const tree = [1, 0, 0, 0, [
        2, 1, 1, 10, [],
        3, 2, 2, 20, [],
        4, 1, 3, 30, [],
      ]]
      const nodes = parseTraceTree(tree)

      assert.strictEqual(nodes.size, 4)
      assert.strictEqual(nodes.get(2).parentId, 1)
      assert.strictEqual(nodes.get(3).parentId, 1)
      assert.strictEqual(nodes.get(4).parentId, 1)
    })
  })

  describe('parseTraceChildren', () => {
    it('does nothing for empty children list', () => {
      const nodes = new Map()
      parseTraceChildren([], nodes, 1)
      assert.strictEqual(nodes.size, 0)
    })

    it('skips incomplete trailing entries (< 5 elements)', () => {
      const nodes = new Map()
      // Only 4 elements — not enough for one child
      parseTraceChildren([2, 1, 5, 100], nodes, 1)
      assert.strictEqual(nodes.size, 0)
    })

    it('adds single child with correct parent', () => {
      const nodes = new Map()
      parseTraceChildren([2, 1, 5, 100, []], nodes, 1)
      assert.deepStrictEqual(nodes.get(2), { functionInfoIndex: 1, parentId: 1, count: 5, size: 100 })
    })

    it('adds multiple siblings', () => {
      const nodes = new Map()
      parseTraceChildren([
        2, 1, 1, 10, [],
        3, 2, 2, 20, [],
      ], nodes, 1)
      assert.strictEqual(nodes.size, 2)
      assert.strictEqual(nodes.get(2).parentId, 1)
      assert.strictEqual(nodes.get(3).parentId, 1)
    })

    it('recursively adds grandchildren', () => {
      const nodes = new Map()
      parseTraceChildren([
        2, 1, 5, 100, [
          3, 2, 3, 60, [],
        ],
      ], nodes, 1)
      assert.strictEqual(nodes.size, 2)
      assert.strictEqual(nodes.get(3).parentId, 2)
    })
  })

  describe('buildStackKey', () => {
    it('returns empty string for unknown node id', () => {
      const nodes = new Map()
      assert.strictEqual(buildStackKey(99, nodes), '')
    })

    it('returns single functionInfoIndex for root-level node', () => {
      const nodes = new Map([
        [2, { functionInfoIndex: 1, parentId: 0, count: 5, size: 100 }],
      ])
      assert.strictEqual(buildStackKey(2, nodes), '1')
    })

    it('joins functionInfoIndexes from leaf to root', () => {
      const nodes = parseTraceTree(TRACE_TREE)
      // Node 3: fi=2, parent=2 (fi=1), parent=1 (fi=0), parent=0 (stop)
      assert.strictEqual(buildStackKey(3, nodes), '2:1:0')
    })

    it('produces different keys for different stacks', () => {
      const nodes = new Map([
        [2, { functionInfoIndex: 1, parentId: 0, count: 1, size: 10 }],
        [3, { functionInfoIndex: 2, parentId: 0, count: 1, size: 10 }],
      ])
      const key2 = buildStackKey(2, nodes)
      const key3 = buildStackKey(3, nodes)
      assert.notStrictEqual(key2, key3)
    })

    it('produces the same key for the same stack path', () => {
      const nodes = parseTraceTree(TRACE_TREE)
      assert.strictEqual(buildStackKey(3, nodes), buildStackKey(3, nodes))
    })
  })

  describe('buildStack', () => {
    it('returns empty array for unknown node id', () => {
      const nodes = new Map()
      assert.deepStrictEqual(buildStack(99, nodes, FUNC_INFOS, STRINGS), [])
    })

    it('skips root frame with empty name and script', () => {
      const nodes = parseTraceTree(TRACE_TREE)
      // Node 1 is root with fi=0 (empty name, empty script) — should produce no frames
      const frames = buildStack(1, nodes, FUNC_INFOS, STRINGS)
      assert.strictEqual(frames.length, 0)
    })

    it('returns single frame for leaf with no parent', () => {
      const nodes = new Map([
        [2, { functionInfoIndex: 1, parentId: 0, count: 5, size: 100 }],
      ])
      const frames = buildStack(2, nodes, FUNC_INFOS, STRINGS)
      assert.strictEqual(frames.length, 1)
      assert.deepStrictEqual(frames[0], { name: 'myFunc', scriptName: 'app.js', line: 10, column: 5 })
    })

    it('returns frames from leaf to root, skipping empty root frame', () => {
      const nodes = parseTraceTree(TRACE_TREE)
      // Node 3 (fi=2 helper) → Node 2 (fi=1 myFunc) → Node 1 (fi=0 root, skipped)
      const frames = buildStack(3, nodes, FUNC_INFOS, STRINGS)
      assert.strictEqual(frames.length, 2)
      assert.deepStrictEqual(frames[0], { name: 'helper', scriptName: 'lib.js', line: 20, column: 0 })
      assert.deepStrictEqual(frames[1], { name: 'myFunc', scriptName: 'app.js', line: 10, column: 5 })
    })

    it('uses (anonymous) for functions with no name', () => {
      // fi=0 has empty name index (strings[0]='') → falls back to '(anonymous)'
      // but fi=0 also has empty scriptName so the frame gets skipped.
      // Use a custom fi where name is empty but scriptName is non-empty.
      const strings = ['', '', 'app.js']
      const funcInfos = [
        0, 0, 2, 0, 5, 0, // fi 0: name='', script='app.js', line=5
      ]
      const nodes = new Map([
        [2, { functionInfoIndex: 0, parentId: 0, count: 1, size: 10 }],
      ])
      const frames = buildStack(2, nodes, funcInfos, strings)
      assert.strictEqual(frames.length, 1)
      assert.strictEqual(frames[0].name, '(anonymous)')
      assert.strictEqual(frames[0].scriptName, 'app.js')
    })
  })

  describe('parseSnapshot', () => {
    function makeSnapshot ({ traceTree = TRACE_TREE, funcInfos = FUNC_INFOS, strings = STRINGS,
      nodes = [], nodeFields = [] } = {}) {
      return JSON.stringify({
        trace_tree: traceTree,
        trace_function_infos: funcInfos,
        strings,
        nodes,
        snapshot: { meta: { node_fields: nodeFields } },
      })
    }

    it('returns empty array for invalid JSON', () => {
      const result = parseSnapshot(['not json'])
      assert.deepStrictEqual(result, [])
    })

    it('returns empty array when required fields are missing', () => {
      assert.deepStrictEqual(parseSnapshot([JSON.stringify({})]), [])
      assert.deepStrictEqual(parseSnapshot([JSON.stringify({ trace_tree: TRACE_TREE })]), [])
    })

    it('clears the chunks array after parsing', () => {
      const chunks = [makeSnapshot()]
      parseSnapshot(chunks)
      assert.strictEqual(chunks.length, 0)
    })

    it('returns alloc entries from trace_tree', () => {
      const result = parseSnapshot([makeSnapshot()])

      assert.ok(result.length > 0, 'should have at least one entry')

      const entry = result.find(e => e.stack.some(f => f.name === 'myFunc'))
      assert.ok(entry, 'should have entry with myFunc frame')
      assert.ok(entry.allocObjects > 0)
      assert.ok(entry.allocSpace > 0)
    })

    it('merges alloc counts for nodes with the same stack', () => {
      // Two siblings with the same fi (same stack key) should be merged
      const tree = [1, 0, 0, 0, [
        2, 1, 3, 30, [],
        3, 1, 2, 20, [],
      ]]
      const result = parseSnapshot([makeSnapshot({ traceTree: tree })])

      const entries = result.filter(e => e.stack.some(f => f.name === 'myFunc'))
      // Both share fi=1 → same functionInfoIndex path from root, so same key '1:0'
      assert.strictEqual(entries.length, 1)
      assert.strictEqual(entries[0].allocObjects, 5)
      assert.strictEqual(entries[0].allocSpace, 50)
    })

    it('includes live data from snapshot nodes', () => {
      const nodeFields = ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness']
      // Node with trace_node_id=2 (points to fi=1, myFunc), self_size=512
      const selfSizeIdx = nodeFields.indexOf('self_size')
      const traceNodeIdIdx = nodeFields.indexOf('trace_node_id')
      const fieldCount = nodeFields.length

      const nodes = new Array(fieldCount).fill(0)
      nodes[selfSizeIdx] = 512
      nodes[traceNodeIdIdx] = 2

      const result = parseSnapshot([makeSnapshot({ nodes, nodeFields })])

      const entry = result.find(e => e.stack.some(f => f.name === 'myFunc'))
      assert.ok(entry, 'should find entry for myFunc')
      assert.strictEqual(entry.liveObjects, 1)
      assert.strictEqual(entry.liveSpace, 512)
    })

    it('creates live-only entry when trace_node_id has no matching alloc entry', () => {
      const nodeFields = ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness']
      const selfSizeIdx = nodeFields.indexOf('self_size')
      const traceNodeIdIdx = nodeFields.indexOf('trace_node_id')
      const fieldCount = nodeFields.length

      // trace_node_id=2 exists in traceNodes but has count=0 in trace_tree
      const tree = [1, 0, 0, 0, [
        2, 1, 0, 0, [], // count=0: won't appear in alloc pass
      ]]

      const nodes = new Array(fieldCount).fill(0)
      nodes[selfSizeIdx] = 256
      nodes[traceNodeIdIdx] = 2

      const result = parseSnapshot([makeSnapshot({ traceTree: tree, nodes, nodeFields })])

      const entry = result.find(e => e.stack.some(f => f.name === 'myFunc'))
      assert.ok(entry, 'should have live-only entry')
      assert.strictEqual(entry.allocObjects, 0)
      assert.strictEqual(entry.allocSpace, 0)
      assert.strictEqual(entry.liveObjects, 1)
      assert.strictEqual(entry.liveSpace, 256)
    })

    it('skips live nodes with trace_node_id=0', () => {
      const nodeFields = ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness']
      const selfSizeIdx = nodeFields.indexOf('self_size')
      const traceNodeIdIdx = nodeFields.indexOf('trace_node_id')
      const fieldCount = nodeFields.length

      const nodes = new Array(fieldCount).fill(0)
      nodes[selfSizeIdx] = 1024
      nodes[traceNodeIdIdx] = 0 // should be skipped

      const result = parseSnapshot([makeSnapshot({ nodes, nodeFields })])

      // All entries should have liveObjects=0 since we skipped trace_node_id=0
      for (const entry of result) {
        assert.strictEqual(entry.liveObjects, 0)
      }
    })

    it('returns empty array when trace_tree is empty', () => {
      const result = parseSnapshot([makeSnapshot({ traceTree: [] })])
      assert.deepStrictEqual(result, [])
    })

    it('concatenates multiple chunks before parsing', () => {
      const full = makeSnapshot()
      const mid = Math.floor(full.length / 2)
      const chunks = [full.slice(0, mid), full.slice(mid)]
      const result = parseSnapshot(chunks)
      assert.ok(result.length > 0)
    })
  })
})
