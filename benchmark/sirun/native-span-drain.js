'use strict'

const DEFAULT_DRAIN_THRESHOLD = 5000

/**
 * A local root span leads its chunk so the WASM pipeline treats it as the chunk
 * root. Mirror of `#isLocalRoot` in packages/dd-trace/src/exporters/native/index.js.
 *
 * @param {object} span
 * @returns {boolean}
 */
function isLocalRoot (span) {
  const context = span.context()

  if (!context._parentId) return true
  if (context._isRemote) return true

  const trace = context._trace
  return Boolean(trace) && trace.started.length > 0 && trace.started[0] === span
}

/**
 * Mirror of `#syncTraceTags` in the native exporter: trace-level tags live on
 * the trace object and are stamped onto the chunk's local root before export.
 *
 * @param {object} span
 */
function syncTraceTags (span) {
  const context = span.context()
  const traceTags = context._trace?.tags

  if (!traceTags) return

  for (const [key, value] of Object.entries(traceTags)) {
    // Don't overwrite existing span tags.
    if (value !== undefined && value !== null && !context.hasTag(key)) {
      context.setTag(key, value)
    }
  }
}

/**
 * Split staged chunks into one `flushSpansGrouped` group per trace, local root
 * first. Mirror of `#groupsFromSpanChunks(spanChunks, true)` in the native
 * exporter, which is the shape the shipped flush path uses.
 *
 * @param {Array<Array<object>>} spanChunks
 * @returns {Array<{spanIds: Uint8Array[], firstIsLocalRoot: boolean}>}
 */
function groupsFromSpanChunks (spanChunks) {
  const groups = []
  for (const spans of spanChunks) {
    const byTrace = new Map()
    for (const span of spans) {
      const trace = span.context()._trace
      let group = byTrace.get(trace)
      if (group === undefined) { group = []; byTrace.set(trace, group) }
      group.push(span)
    }

    for (const group of byTrace.values()) {
      const root = group.find(isLocalRoot)
      const firstIsLocalRoot = root !== undefined
      let ordered = group
      if (firstIsLocalRoot) {
        syncTraceTags(root)
        if (group[0] !== root) {
          ordered = [root, ...group.filter(span => span !== root)]
        }
      }
      groups.push({
        spanIds: ordered.map(span => span.context()._nativeSpanId),
        firstIsLocalRoot,
      })
    }
  }
  return groups
}

/**
 * Periodically move finished native spans out of WASM storage so a long bench
 * loop does not grow the native span map without bound.
 *
 * Staging mirrors the shipped export path: each processor export call is kept as
 * its own trace chunk, every chunk is split into one group per trace with the
 * local root first, and the groups go through the public
 * `nativeSpans.flushSpansGrouped`. Staging a single chunk for all pending spans
 * instead would skip the per-trace `prepareChunk` and the per-chunk trace-tag
 * stamping production pays on every flush, so the bench would report the cost of
 * a pipeline we do not ship.
 *
 * @param {object} tracer Initialized tracer
 * @param {number} [threshold] Pending spans that trigger a drain
 */
function createNativeSpanDrain (tracer, threshold = DEFAULT_DRAIN_THRESHOLD) {
  const nativeSpans = tracer._tracer._nativeSpans
  // JS-only mode has nothing in native storage: every entry point stays a no-op.
  const pendingChunks = nativeSpans ? [] : null
  let pendingCount = 0
  let flushedGroups = 0
  let problems = 0
  const reported = new Set()

  // A silent catch would let a run that never staged or sent a single chunk
  // report clean numbers, hiding exactly the work these benches claim to
  // measure. Print the first occurrence of each distinct failure, count the rest
  // and summarize at exit, so a broken drain is visible without flooding the
  // sirun output on every one of the hundreds of drains a run performs.
  function report (message) {
    problems++
    if (reported.has(message)) return
    reported.add(message)
    process.stderr.write(`native span drain: ${message}\n`)
  }

  if (pendingChunks) {
    process.on('exit', () => {
      if (problems > 0) {
        process.stderr.write(
          `native span drain: ${problems} failed drain(s), ${flushedGroups} trace group(s) flushed\n`
        )
      } else if (flushedGroups === 0) {
        process.stderr.write('native span drain: no trace group was ever flushed\n')
      }
    })
  }

  function addAll (spans) {
    if (!pendingChunks || spans.length === 0) return

    // SpanProcessor reassigns `trace.started` rather than mutating it, so
    // holding this array is safe — the real exporter buffers it the same way.
    pendingChunks.push(spans)
    pendingCount += spans.length
  }

  async function drain () {
    if (!pendingChunks || pendingCount === 0) return

    const groups = groupsFromSpanChunks(pendingChunks)
    pendingChunks.length = 0
    pendingCount = 0

    try {
      // flushSpansGrouped drains the change queue itself, then prepares one
      // chunk per group and sends them as a single request.
      const response = await nativeSpans.flushSpansGrouped(groups)
      if (response === 'no spans to flush') {
        report(`staged no chunk for ${groups.length} trace group(s)`)
      } else {
        flushedGroups += groups.length
      }
    } catch (err) {
      report(`flushSpansGrouped rejected: ${err?.message ?? err}`)
    }
  }

  function needsDrain () {
    return pendingCount >= threshold
  }

  return { addAll, drain, needsDrain }
}

module.exports = { createNativeSpanDrain }
