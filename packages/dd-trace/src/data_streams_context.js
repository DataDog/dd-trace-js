const { storage, SPAN_NAMESPACE } = require('../../datadog-core')
const log = require('./log')

function getDataStreamsContext () {
  const store = storage(SPAN_NAMESPACE).getStore()
  return (store && store.dataStreamsContext) || null
}

function setDataStreamsContext (dataStreamsContext) {
  log.debug(() => `Setting new DSM Context: ${JSON.stringify(dataStreamsContext)}.`)

  if (dataStreamsContext) storage(SPAN_NAMESPACE).enterWith({ ...(storage(SPAN_NAMESPACE).getStore()), dataStreamsContext })
}

module.exports = {
  getDataStreamsContext,
  setDataStreamsContext
}
