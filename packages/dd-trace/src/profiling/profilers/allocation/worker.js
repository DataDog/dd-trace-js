'use strict'

const inspector = require('node:inspector')
const { parentPort } = require('node:worker_threads')

const { parseSnapshot } = require('./snapshot-parser')
const { buildPprofProfile } = require('./profile-builder')

const session = new inspector.Session()
session.connectToMainThread()

// Snapshot collection state
const snapshotChunks = []
let collectingSnapshot = false

/**
 * Timeline tracking state
 * Intervals record timestamps from lastSeenObjectId, marking interval boundaries.
 */
const intervals = []

/**
 * Per-fragment live-object stats from heapStatsUpdate events.
 * Maintain a running map of all fragments and aggregate on demand.
 */
const fragments = new Map()
let tracking = false

/**
 * Running live-heap totals, updated incrementally via deltas from each
 * heapStatsUpdate event. This avoids iterating all fragments every ~50ms —
 * only the changed fragments (reported by V8) are processed per event.
 */
let totalLiveCount = 0
let totalLiveSize = 0

/**
 * Cumulative allocation counters. Incremented when a fragment is first seen
 * (its initial count/size) and when an existing fragment's count or size
 * increases (positive deltas only — GC decreases are ignored). Accumulated
 * as running sums so consecutive timeline samples can be diffed for
 * per-interval allocation rates.
 */
let cumulativeAllocCount = 0
let cumulativeAllocSize = 0

session.on('HeapProfiler.addHeapSnapshotChunk', ({ params }) => {
  if (collectingSnapshot) {
    snapshotChunks.push(params.chunk)
  }
})

session.on('HeapProfiler.heapStatsUpdate', ({ params }) => {
  if (!tracking) return
  // statsUpdate is triplets: [fragmentIndex, count, size, ...]
  // V8 reports only changed fragments per event, so we apply deltas to
  // running totals instead of iterating all fragments every time.
  const updates = params.statsUpdate
  for (let i = 0; i < updates.length; i += 3) {
    const index = updates[i]
    const newCount = updates[i + 1]
    const newSize = updates[i + 2]
    const existing = fragments.get(index)
    if (existing) {
      const countDelta = newCount - existing.count
      const sizeDelta = newSize - existing.size
      totalLiveCount += countDelta
      totalLiveSize += sizeDelta
      if (countDelta > 0) {
        cumulativeAllocCount += countDelta
      }
      if (sizeDelta > 0) {
        cumulativeAllocSize += sizeDelta
      }
      existing.count = newCount
      existing.size = newSize
    } else {
      fragments.set(index, { count: newCount, size: newSize })
      totalLiveCount += newCount
      totalLiveSize += newSize
      cumulativeAllocCount += newCount
      cumulativeAllocSize += newSize
    }
  }

  // Stamp running totals onto the most recent interval
  if (intervals.length > 0) {
    const last = intervals[intervals.length - 1]
    last.liveCount = totalLiveCount
    last.liveSize = totalLiveSize
    last.allocCount = cumulativeAllocCount
    last.allocSize = cumulativeAllocSize
  }
})

session.on('HeapProfiler.lastSeenObjectId', ({ params }) => {
  if (!tracking) return
  intervals.push({
    timestamp: params.timestamp,
    lastSeenObjectId: params.lastSeenObjectId,
    allocCount: cumulativeAllocCount,
    allocSize: cumulativeAllocSize,
  })
})

/**
 * Post a CDP command and return a Promise for the result.
 *
 * @param {string} method - CDP method name
 * @param {object} [params] - CDP method parameters
 * @returns {Promise<object>} CDP response
 */
function post (method, params = {}) {
  return new Promise((resolve, reject) => {
    session.post(method, params, (error, result) => {
      if (error) {
        reject(error)
        return
      }
      resolve(result)
    })
  })
}

/**
 * Send a message to the parent thread.
 *
 * @param {string} type - Message type
 * @param {object} [extra] - Additional message fields
 * @param {ArrayBuffer[]} [transferList] - Buffers to transfer
 */
function send (type, extra = {}, transferList) {
  parentPort.postMessage({ type, ...extra }, transferList)
}

/**
 * Reset timeline tracking state for a new window.
 */
function resetTimeline () {
  intervals.length = 0
  fragments.clear()
  totalLiveCount = 0
  totalLiveSize = 0
  cumulativeAllocCount = 0
  cumulativeAllocSize = 0
}

/**
 * Handle a message from the parent thread.
 *
 * @param {object} message - Message from parent
 */
async function handleMessage (message) {
  if (!message?.type) return

  switch (message.type) {
    case 'start-tracking': {
      resetTimeline()
      tracking = true
      await post('HeapProfiler.startTrackingHeapObjects', { trackAllocations: true })
      send('tracking-started')
      break
    }

    case 'stop-and-build-profile': {
      // Start collecting snapshot chunks. Keep tracking=true so the final
      // heapStatsUpdate/lastSeenObjectId events (fired during stop) are captured.
      collectingSnapshot = true
      snapshotChunks.length = 0
      await post('HeapProfiler.stopTrackingHeapObjects')
      collectingSnapshot = false
      tracking = false

      const allocations = parseSnapshot(snapshotChunks)
      snapshotChunks.length = 0

      const startDate = new Date(message.startDate)
      const endDate = new Date(message.endDate)
      const profile = buildPprofProfile(allocations, startDate, endDate, intervals)
      resetTimeline()

      const encoded = await profile.encodeAsync()
      // Avoid copying if the Uint8Array already owns the entire backing buffer
      const ab = encoded.byteOffset === 0 && encoded.byteLength === encoded.buffer.byteLength
        ? encoded.buffer
        : encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength)
      send('profile-result', { buffer: Buffer.from(ab) }, [ab])
      break
    }

    case 'shutdown': {
      tracking = false
      await post('HeapProfiler.disable')
      session.disconnect()
      process.exit(0)
    }
  }
}

// Using queue to make sure messages are processed sequential since handleMessage is async
let messageQueue = Promise.resolve()

parentPort.on('message', (message) => {
  messageQueue = messageQueue
    .then(() => handleMessage(message))
    .catch((error) => {
      send('error', { message: error.message })
    })
})

post('HeapProfiler.enable')
  .then(() => {
    send('ready')
  })
  .catch((error) => {
    send('error', { message: error.message })
  })
