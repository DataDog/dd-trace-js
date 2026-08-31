'use strict'

const { storage } = require('../../../datadog-core')
const log = require('../log')

const legacyStorage = storage('legacy')

function getDataStreamsContext () {
  const store = legacyStorage.getStore()
  return (store && store.dataStreamsContext) || null
}

function setDataStreamsContext (dataStreamsContext) {
  log.debug('Setting new DSM Context: %j.', dataStreamsContext)

  // `undefined` clears: a message that carries no context must not inherit the previous message's.
  // The identity check keeps the common no-context case from allocating a store per message.
  const store = legacyStorage.getStore()
  if (store?.dataStreamsContext !== dataStreamsContext) {
    legacyStorage.enterWith({ ...store, dataStreamsContext })
  }
}

module.exports = {
  getDataStreamsContext,
  setDataStreamsContext,
}
