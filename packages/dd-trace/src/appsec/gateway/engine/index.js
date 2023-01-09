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

function needsAddress (address) {
  return manager.addresses.has(address)
}

function propagate (data, context = getContext()) {
  if (!context) return

  const keys = Object.keys(data)

  for (let i = 0; i < keys.length; ++i) {
    const key = keys[i]

    if (needsAddress(key)) {
      context.setValue(key, data[key])
    }
  }

  return context.dispatch()
}

module.exports = {
  manager,
  startContext,
  getContext,
  needsAddress,
  propagate
}
