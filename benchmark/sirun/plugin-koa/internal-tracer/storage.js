'use strict'

const { channel } = require('diagnostics_channel')
const { storage } = require('../../../../packages/datadog-core')

const startChannel = channel('apm:koa:request:start')
const endChannel = channel('apm:koa:request:end')

const stores = []

startChannel.subscribe(() => {
  const store = storage.getStore()

  stores.push(store)
  storage.enterWith({ ...store })
})

endChannel.subscribe(() => {
  storage.enterWith(stores.pop())
})
