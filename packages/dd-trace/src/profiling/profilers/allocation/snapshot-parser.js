'use strict'

const FUNC_INFO_FIELDS = 6

/**
 * Parse the V8 trace_tree and build a map of trace node id to node info.
 *
 * V8 serializes trace_tree as a nested array:
 *   [id, functionInfoIndex, count, size, [children_flat]]
 * where children_flat contains children interleaved as 5-element groups:
 *   [c1_id, c1_fi, c1_count, c1_size, [c1_grandchildren], c2_id, ...]
 *
 * The count/size on each trace node represent TOTAL allocations tracked at
 * that call site during the window, including objects later GC'd.
 *
 * @param {Array} traceTree - Root trace tree node array from snapshot
 * @returns {Map<number, {functionInfoIndex: number, parentId: number, count: number, size: number}>}
 */
function parseTraceTree (traceTree) {
  const traceNodes = new Map()
  if (!Array.isArray(traceTree) || traceTree.length < 5) return traceNodes

  // Root node
  traceNodes.set(traceTree[0], {
    functionInfoIndex: traceTree[1],
    parentId: 0,
    count: traceTree[2],
    size: traceTree[3],
  })

  const rootChildren = traceTree[4]
  if (Array.isArray(rootChildren) && rootChildren.length > 0) {
    parseTraceChildren(rootChildren, traceNodes, traceTree[0])
  }

  return traceNodes
}

/**
 * Parse a flat children array from the trace tree.
 * Children are interleaved as 5-element groups within the array.
 *
 * @param {Array} childrenList - Flat array of interleaved child fields
 * @param {Map<number, {functionInfoIndex: number, parentId: number, count: number, size: number}>} traceNodes
 * @param {number} parentId - Parent node id
 */
function parseTraceChildren (childrenList, traceNodes, parentId) {
  for (let i = 0; i + 4 < childrenList.length; i += 5) {
    const id = childrenList[i]
    const functionInfoIndex = childrenList[i + 1]
    const count = childrenList[i + 2]
    const size = childrenList[i + 3]
    const grandchildren = childrenList[i + 4]

    traceNodes.set(id, { functionInfoIndex, parentId, count, size })

    if (Array.isArray(grandchildren) && grandchildren.length > 0) {
      parseTraceChildren(grandchildren, traceNodes, id)
    }
  }
}

/**
 * Build a string key representing the stack for deduplication.
 *
 * @param {number} traceNodeId - Leaf trace node id
 * @param {Map<number, {functionInfoIndex: number, parentId: number}>} traceNodes - Trace tree node map
 * @returns {string} Unique stack key
 */
function buildStackKey (traceNodeId, traceNodes) {
  let key = ''
  let currentId = traceNodeId
  while (currentId !== 0) {
    const node = traceNodes.get(currentId)
    if (!node) break
    if (key) key += ':'
    key += node.functionInfoIndex
    currentId = node.parentId
  }
  return key
}

/**
 * Build a stack trace array from a trace node up to the root.
 *
 * @param {number} traceNodeId - Leaf trace node id
 * @param {Map<number, {functionInfoIndex: number, parentId: number}>} traceNodes
 * @param {number[]} traceFunctionInfos - Flat array of function info fields
 * @param {string[]} strings - Snapshot string table
 * @returns {Array<{name: string, scriptName: string, line: number, column: number}>}
 */
function buildStack (traceNodeId, traceNodes, traceFunctionInfos, strings) {
  const frames = []
  let currentId = traceNodeId
  while (currentId !== 0) {
    const node = traceNodes.get(currentId)
    if (!node) break

    const infoOffset = node.functionInfoIndex * FUNC_INFO_FIELDS
    const nameIndex = traceFunctionInfos[infoOffset + 1]
    const scriptNameIndex = traceFunctionInfos[infoOffset + 2]
    const line = traceFunctionInfos[infoOffset + 4]
    const column = traceFunctionInfos[infoOffset + 5]

    const origName = strings[nameIndex]
    const origScript = strings[scriptNameIndex]

    // Skip the root node which has empty name and script
    if (origName || origScript) {
      frames.push({
        name: origName || '(anonymous)',
        scriptName: origScript || '',
        line,
        column,
      })
    }

    currentId = node.parentId
  }
  return frames
}

/**
 * Parse a V8 heap snapshot from raw chunks and extract per-stack allocation data.
 *
 * Accepts the chunks array directly and manages memory lifecycle internally:
 * chunks are released before joining, the JSON string is released after parsing,
 * and large snapshot fields (nodes) are released after extraction.
 *
 * Produces two dimensions per unique call stack:
 *   - alloc (from trace_tree): total objects/bytes allocated during the window
 *   - live (from snapshot nodes): objects/bytes still alive at snapshot time
 *
 * @param {string[]} chunks - Raw heap snapshot JSON chunks from CDP
 * @returns {Array<{stack: Array<{name: string, scriptName: string, line: number, column: number}>,
 *   allocObjects: number, allocSpace: number, liveObjects: number, liveSpace: number}>}
 */
function parseSnapshot (chunks) {
  // Join chunks into a single JSON string, then release the chunk array
  let snapshotJson = chunks.join('')
  chunks.length = 0

  let snapshot
  try {
    snapshot = JSON.parse(snapshotJson)
  } catch {
    return []
  }

  // Release the JSON string
  snapshotJson = undefined // eslint-disable-line no-useless-assignment

  const { trace_tree: traceTree, trace_function_infos: traceFunctionInfos, strings } = snapshot
  if (!traceTree || !traceFunctionInfos || !strings) {
    return []
  }

  // Extract the large fields we need, then release the snapshot object.
  const nodesFlat = snapshot.nodes
  const nodeFields = snapshot.snapshot?.meta?.node_fields
  snapshot = undefined // eslint-disable-line no-useless-assignment

  const traceNodes = parseTraceTree(traceTree)
  if (traceNodes.size === 0) return []

  // Merged map: stackKey -> { stack, allocObjects, allocSpace, liveObjects, liveSpace }
  const stackMap = new Map()
  // Cache stackKey per traceNodeId to avoid re-walking parent chains in the live pass
  const stackKeyCache = new Map()

  /**
   * Get or compute the stack key for a trace node, caching the result.
   *
   * @param {number} traceNodeId
   * @returns {string}
   */
  function cachedStackKey (traceNodeId) {
    const hasTrace = stackKeyCache.has(traceNodeId)
    if (!hasTrace) {
      const key = buildStackKey(traceNodeId, traceNodes)
      stackKeyCache.set(traceNodeId, key)
    }

    return stackKeyCache.get(traceNodeId)
  }

  // Collect total allocated data from trace_tree count/size
  for (const [traceNodeId, node] of traceNodes) {
    if (node.count === 0) continue
    const stackKey = cachedStackKey(traceNodeId)
    if (!stackKey) continue

    const existing = stackMap.get(stackKey)
    if (existing) {
      existing.allocObjects += node.count
      existing.allocSpace += node.size
    } else {
      const stack = buildStack(traceNodeId, traceNodes, traceFunctionInfos, strings)
      stackMap.set(stackKey, {
        stack,
        allocObjects: node.count,
        allocSpace: node.size,
        liveObjects: 0,
        liveSpace: 0,
      })
    }
  }

  // Collect live data from snapshot nodes (live objects at snapshot time)
  if (nodesFlat && nodeFields) {
    const traceNodeIdIndex = nodeFields.indexOf('trace_node_id')
    const selfSizeIndex = nodeFields.indexOf('self_size')

    if (traceNodeIdIndex !== -1 && selfSizeIndex !== -1) {
      const nodeFieldCount = nodeFields.length

      // Group live objects by trace_node_id
      const liveByTraceNode = new Map()
      for (let i = 0; i < nodesFlat.length; i += nodeFieldCount) {
        const traceNodeId = nodesFlat[i + traceNodeIdIndex]
        if (traceNodeId === 0) continue

        const selfSize = nodesFlat[i + selfSizeIndex]
        const existing = liveByTraceNode.get(traceNodeId)
        if (existing) {
          existing.count++
          existing.size += selfSize
        } else {
          liveByTraceNode.set(traceNodeId, { count: 1, size: selfSize })
        }
      }

      // Merge live data into alloc entries by stack key
      for (const [traceNodeId, live] of liveByTraceNode) {
        const stackKey = cachedStackKey(traceNodeId)
        if (!stackKey) continue

        const existing = stackMap.get(stackKey)
        if (existing) {
          existing.liveObjects += live.count
          existing.liveSpace += live.size
        } else {
          // Live object with no matching alloc trace entry — include as live-only
          const stack = buildStack(traceNodeId, traceNodes, traceFunctionInfos, strings)
          stackMap.set(stackKey, {
            stack,
            allocObjects: 0,
            allocSpace: 0,
            liveObjects: live.count,
            liveSpace: live.size,
          })
        }
      }
    }
  }

  return [...stackMap.values()]
}

module.exports = { parseTraceTree, parseTraceChildren, buildStackKey, buildStack, parseSnapshot }
