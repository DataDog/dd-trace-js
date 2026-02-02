'use strict'

const { storage } = require('../../../datadog-core')
const log = require('../log')

function getDataStreamsContext () {
  const store = storage('legacy').getStore()
  return (store && store.dataStreamsContext) || null
}

function setDataStreamsContext (dataStreamsContext) {
  log.debug('Setting new DSM Context: %j.', dataStreamsContext)

  if (dataStreamsContext) storage('legacy').enterWith({ ...(storage('legacy').getStore()), dataStreamsContext })
}

function syncToStore (ctx) {
  const dsmContext = getDataStreamsContext()
  if (dsmContext && ctx?.currentStore) {
    ctx.currentStore = { ...ctx.currentStore, dataStreamsContext: dsmContext }
  }
  return ctx?.currentStore
}

module.exports = {
  getDataStreamsContext,
  setDataStreamsContext,
  syncToStore,
}
