'use strict'

const { getRuntimeObject } = require('./collector')
const { processRawState } = require('./processor')

const DEFAULT_MAX_REFERENCE_DEPTH = 3
const DEFAULT_MAX_LENGTH = 255

module.exports = {
  getLocalStateForCallFrame
}

async function getLocalStateForCallFrame (
  callFrame,
  { maxReferenceDepth = DEFAULT_MAX_REFERENCE_DEPTH, maxLength = DEFAULT_MAX_LENGTH } = {}
) {
  const rawState = []
  let processedState = null

  for (const scope of callFrame.scopeChain) {
    if (scope.type === 'global') continue // The global scope is too noisy
    rawState.push(...await getRuntimeObject(scope.object.objectId, maxReferenceDepth))
  }

  // Deplay calling `processRawState` so the caller gets a chance to resume the main thread before processing `rawState`
  return () => {
    processedState = processedState ?? processRawState(rawState, maxLength)
    return processedState
  }
}
