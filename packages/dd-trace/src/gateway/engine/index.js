'use strict'

const { SubscriptionManager, Context } = require('./engine')
const als = require('../als')

const manager = new SubscriptionManager()
Context.setManager(manager)

function startContext () {
  const store = new Map()

  store.set('context', new Context())

  als.enterWith(store)

  return store
}

function getContext () {
  const store = als.getStore()

  return store && store.get('context')
}

function propagate (data, context = getContext()) {
  if (!context) return

  const keys = Object.keys(data)

  for (let i = 0; i < keys.length; ++i) {
    const key = keys[i]

    if (manager.addresses.has(key)) {
      context.setValue(key, data[key])
    }
  }

  const { appsecKeep } = context.dispatch()
  if (appsecKeep) {
    const store = als.getStore()
    const req = store && store.get('req')
    const topSpan = req && req._datadog && req._datadog.span
    if (!topSpan) return
    // TODO(vdeturckheim) check/ask if we need to place this on the current span too
    topSpan.setTag('manual.keep')
    topSpan.setTag('appsec.event', true)
    topSpan.setTag('_dd.origin', 'appsec')
  }
}

module.exports = {
  manager,
  startContext,
  getContext,
  propagate
}
