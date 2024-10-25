const { storage } = require('../../datadog-core')
const log = require('./log')

function getDataStreamsContext () {
  const store = storage.getStore()
  return (store && store.dataStreamsContext) || null
}

function setDataStreamsContext (dataStreamsContext) {
  log.debug(() => `Setting new DSM Context: ${JSON.stringify(dataStreamsContext)}.`)

  if (dataStreamsContext) storage.enterWith({ ...(storage.getStore()), dataStreamsContext })
}

module.exports = {
  getDataStreamsContext,
  setDataStreamsContext
}
