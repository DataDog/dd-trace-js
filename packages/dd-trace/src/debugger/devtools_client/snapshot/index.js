'use strict'

const { getRuntimeObject } = require('./collector')
const { processRawState } = require('./processor')
const log = require('../log')

const DEFAULT_MAX_REFERENCE_DEPTH = 3
const DEFAULT_MAX_COLLECTION_SIZE = 100
const DEFAULT_MAX_FIELD_COUNT = 20
const DEFAULT_MAX_LENGTH = 255

module.exports = {
  getLocalStateForCallFrame
}

async function getLocalStateForCallFrame (
  callFrame,
  {
    maxReferenceDepth = DEFAULT_MAX_REFERENCE_DEPTH,
    maxCollectionSize = DEFAULT_MAX_COLLECTION_SIZE,
    maxFieldCount = DEFAULT_MAX_FIELD_COUNT,
    maxLength = DEFAULT_MAX_LENGTH
  } = {}
) {
  const rawState = []
  let processedState = null

  try {
    await Promise.all(callFrame.scopeChain.map(async (scope) => {
      if (scope.type === 'global') return // The global scope is too noisy
      rawState.push(...await getRuntimeObject(
        scope.object.objectId,
        { maxReferenceDepth, maxCollectionSize, maxFieldCount }
      ))
    }))
  } catch (err) {
    // TODO: We might be able to get part of the scope chain.
    // Consider if we could set errors just for the part of the scope chain that throws during collection.
    log.error('[debugger:devtools_client] Error getting local state for call frame', err)
    return () => new Error('Error getting local state')
  }

  // Delay calling `processRawState` so the caller gets a chance to resume the main thread before processing `rawState`
  return () => {
    processedState = processedState ?? processRawState(rawState, maxLength)
    return processedState
  }
}
