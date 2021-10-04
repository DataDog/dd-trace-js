'use strict'
const Gateway = require('../gateway/engine/index')
class ContextStore {
  constructor () {
    this.top = new Map()
    this.all = new Map()
  }

  setDataTop (key, value) {
    this.top.set(key, value)
  }

  setDataAll (key, value) {
    this.all.set(key, value)
  }

  setDataCurrent (key, value) {
    return this.setTagCurrent(key, value) // For now this is the only way
  }

  setTagTop (key, value) {
    const store = Gateway.getStore()
    if (!store) return
    const req = store.get('req')
    if (!req) return
    req._datadog.span.setTag(key, value)
  }

  setTagCurrent (key, value) {
    const span = global._ddtrace._tracer.scope().active()
    if (span) span.setTag(key, value)
  }
}

module.exports = ContextStore
