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

  if (dataStreamsContext) legacyStorage.enterWith({ ...legacyStorage.getStore(), dataStreamsContext })
}

module.exports = {
  getDataStreamsContext,
  setDataStreamsContext,
}
