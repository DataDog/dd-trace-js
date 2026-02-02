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

/**
 * Syncs the current DSM context from AsyncLocalStorage to ctx.currentStore.
 *
 * This is necessary because setDataStreamsContext uses enterWith() which modifies
 * AsyncLocalStorage directly, but ctx.currentStore (returned from bindStart) is what
 * gets bound to async continuations via store.run(). Without syncing, DSM context
 * would not be properly scoped to each handler's async continuations.
 *
 * @param {object} ctx - The context object containing currentStore
 * @returns {object|undefined} The updated currentStore, or undefined if no sync occurred
 */
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
