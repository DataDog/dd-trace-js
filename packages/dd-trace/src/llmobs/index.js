'use strict'

const log = require('../log')
const { PROPAGATED_PARENT_ID_KEY } = require('./constants')
const { storage } = require('../../../datadog-core')

const { channel } = require('dc-polyfill')
const injectCh = channel('dd-trace:span:inject')

function enable (config) {
  injectCh.subscribe(handleLLMObsParentIdInjection)
}

function disable () {
  if (injectCh.hasSubscribers) injectCh.unsubscribe(handleLLMObsParentIdInjection)
}

// since LLMObs traces can extend between services and be the same trace,
// we need to propogate the parent id.
function handleLLMObsParentIdInjection ({ carrier }) {
  const parent = storage.getStore()?.llmobsSpan
  if (!parent) {
    log.debug('No active span to inject LLMObs info.')
    return
  }

  const parentId = parent?.context().toSpanId()

  carrier['x-datadog-tags'] += `,${PROPAGATED_PARENT_ID_KEY}=${parentId}`
}

module.exports = { enable, disable }
