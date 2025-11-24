'use strict'

const { collectObjectProperties } = require('./collector')
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
 * @property {number} [maxReferenceDepth] - The maximum depth of the object to traverse. Defaults to
 *   {@link DEFAULT_MAX_REFERENCE_DEPTH}.
 * @property {number} [maxCollectionSize] - The maximum size of a collection to include in the snapshot. Defaults to
 *   {@link DEFAULT_MAX_COLLECTION_SIZE}.
 * @property {number} [maxFieldCount] - The maximum number of properties on an object to include in the snapshot.
 *   Defaults to {@link DEFAULT_MAX_FIELD_COUNT}.
 * @property {number} [maxLength] - The maximum length of a string to include in the snapshot. Defaults to
 *   {@link DEFAULT_MAX_LENGTH}.
 * @property {bigint} [deadlineNs] - The deadline in nanoseconds compared to `process.hrtime.bigint()`. Defaults to
 *   {@link BIGINT_MAX}. If the deadline is reached, the snapshot will be truncated.
 */

/**
 * Get the local state for a call frame.
 *
 * @param {import('inspector').Debugger.CallFrame} callFrame - The call frame to get the local state for
 * @param {GetLocalStateForCallFrameOptions} [opts] - The options for the snapshot
 * @returns {Promise<Object>} The local state for the call frame
 */
async function getLocalStateForCallFrame (
  callFrame,
  {
    maxReferenceDepth = DEFAULT_MAX_REFERENCE_DEPTH,
    maxCollectionSize = DEFAULT_MAX_COLLECTION_SIZE,
    maxFieldCount = DEFAULT_MAX_FIELD_COUNT,
    maxLength = DEFAULT_MAX_LENGTH,
    deadlineNs = BIGINT_MAX
  } = {}
) {
  const rawState = []
  let processedState = null

  try {
    const opts = {
      maxReferenceDepth,
      maxCollectionSize,
      maxFieldCount,
      deadlineNs,
      ctx: { deadlineReached: false }
    }
    for (const scope of callFrame.scopeChain) {
      if (scope.type === 'global') continue // The global scope is too noisy
      const { objectId } = scope.object
      if (objectId === undefined) continue // I haven't seen this happen, but according to the types it's possible
      // The objectId for a scope points to a pseudo-object whos properties are the actual variables in the scope.
      // This is why we can just call `collectObjectProperties` directly and expect it to return the in-scope variables
      // as an array.
      // eslint-disable-next-line no-await-in-loop
      rawState.push(...await collectObjectProperties(objectId, opts))
      if (opts.ctx.deadlineReached === true) break // TODO: Bad UX; Variables in remaining scopes are silently dropped
    }
  } catch (err) {
    // TODO: We might be able to get part of the scope chain.
    // Consider if we could set errors just for the part of the scope chain that throws during collection.
    log.error('[debugger:devtools_client] Error getting local state for call frame', err)
    return returnError
  }

  // Delay calling `processRawState` so the caller gets a chance to resume the main thread before processing `rawState`
  return () => {
    processedState = processedState ?? processRawState(rawState, maxLength)
    return processedState
  }
}
