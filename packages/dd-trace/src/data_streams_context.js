const { storage, LEGACY_STORAGE_NAMESPACE } = require('../../datadog-core')
const log = require('./log')

function getDataStreamsContext () {
  const store = storage(LEGACY_STORAGE_NAMESPACE).getStore()
  return (store && store.dataStreamsContext) || null
}

function setDataStreamsContext (dataStreamsContext) {
  log.debug(() => `Setting new DSM Context: ${JSON.stringify(dataStreamsContext)}.`)

  if (dataStreamsContext) storage(LEGACY_STORAGE_NAMESPACE).enterWith({ ...(storage(LEGACY_STORAGE_NAMESPACE).getStore()), dataStreamsContext })
}

module.exports = {
  getDataStreamsContext,
  setDataStreamsContext
}
