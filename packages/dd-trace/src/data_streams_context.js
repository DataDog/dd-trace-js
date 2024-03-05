const { storage } = require('../../datadog-core')

function getDataStreamsContext () {
  const store = storage.getStore()
  return (store && store.dataStreamsContext) || null
}

function setDataStreamsContext (dataStreamsContext) {
  if (dataStreamsContext) storage.enterWith({ ...(storage.getStore()), dataStreamsContext })
}

module.exports = {
  getDataStreamsContext,
  setDataStreamsContext
}
