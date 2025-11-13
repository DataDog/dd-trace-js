'use strict'

const { getRuntimeObject } = require('./collector')
const { processRawState } = require('./processor')
const log = require('../log')

const BIGINT_MAX = (1n << 256n) - 1n

const DEFAULT_MAX_REFERENCE_DEPTH = 3
const DEFAULT_MAX_COLLECTION_SIZE = 100
const DEFAULT_MAX_FIELD_COUNT = 20
const DEFAULT_MAX_LENGTH = 255

module.exports = {
  getLocalStateForCallFrame
}

function returnError () {
  return new Error('Error getting local state')
}

/**
 * @typedef {Object} GetLocalStateForCallFrameOptions
 * @property {number} [maxReferenceDepth=DEFAULT_MAX_REFERENCE_DEPTH] - The maximum depth of the object to traverse
 * @property {number} [maxCollectionSize=DEFAULT_MAX_COLLECTION_SIZE] - The maximum size of a collection to include
 *   in the snapshot
 * @property {number} [maxFieldCount=DEFAULT_MAX_FIELD_COUNT] - The maximum number of properties on an object to
 *   include in the snapshot
 * @property {number} [maxLength=DEFAULT_MAX_LENGTH] - The maximum length of a string to include in the snapshot
 * @property {bigint} [deadlineNs=BIGINT_MAX] - The deadline in nanoseconds compared to
 *   `process.hrtime.bigint()`. If the deadline is reached, the snapshot will be truncated.
 * @property {boolean} [deadlineReached=false] - Whether the deadline has been reached. Should not be set by the
 *   caller, but is used to signal the deadline overrun to the caller.
 */

/**
 * Get the local state for a call frame.
 *
 * @param {import('inspector').Debugger.CallFrame} callFrame - The call frame to get the local state for
 * @param {GetLocalStateForCallFrameOptions} [opts={}] - The options for the snapshot
 * @returns {Promise<Object>} The local state for the call frame
 */
async function getLocalStateForCallFrame (callFrame, opts = {}) {
  opts.maxReferenceDepth ??= DEFAULT_MAX_REFERENCE_DEPTH
  opts.maxCollectionSize ??= DEFAULT_MAX_COLLECTION_SIZE
  opts.maxFieldCount ??= DEFAULT_MAX_FIELD_COUNT
  opts.maxLength ??= DEFAULT_MAX_LENGTH
  opts.deadlineNs ??= BIGINT_MAX
  opts.deadlineReached ??= false
  const rawState = []
  let processedState = null

  try {
    for (const scope of callFrame.scopeChain) {
      if (opts.deadlineReached === true) break // TODO: Variables in scope are silently dropped: Not the best UX
      if (scope.type === 'global') continue // The global scope is too noisy
      // eslint-disable-next-line no-await-in-loop
      rawState.push(...await getRuntimeObject(scope.object.objectId, opts))
    }
  } catch (err) {
    // TODO: We might be able to get part of the scope chain.
    // Consider if we could set errors just for the part of the scope chain that throws during collection.
    log.error('[debugger:devtools_client] Error getting local state for call frame', err)
    return returnError
  }

  // Delay calling `processRawState` so the caller gets a chance to resume the main thread before processing `rawState`
  return () => {
    processedState = processedState ?? processRawState(rawState, opts.maxLength)
    return processedState
  }
}
