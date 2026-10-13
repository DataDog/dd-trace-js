'use strict'

const assert = require('node:assert/strict')
const { AsyncLocalStorage } = require('node:async_hooks')

const [firstPath, secondPath] = process.argv.slice(2)
const first = require(firstPath)
const channelName = 'dd-trace:test:dc-polyfill:channel'
const storeChannelName = 'dd-trace:test:dc-polyfill:store'
const firstChannel = first.channel(channelName)
const firstStoreChannel = first.channel(storeChannelName)
const storage = new AsyncLocalStorage()

assert.equal(firstChannel.hasSubscribers, false)
firstStoreChannel.bindStore(storage, ({ value }) => value)

const second = require(secondPath)
const secondChannel = second.channel(channelName)
const secondStoreChannel = second.channel(storeChannelName)

assert.strictEqual(firstChannel, secondChannel)
assert.strictEqual(firstStoreChannel, secondStoreChannel)
assert.equal(firstChannel.hasSubscribers, false)

let storedValue
secondStoreChannel.runStores({ value: 'shared store' }, () => {
  storedValue = storage.getStore()
})
assert.equal(storedValue, 'shared store')

const messages = []
const onMessage = message => messages.push(message)
secondChannel.subscribe(onMessage)
firstChannel.publish('shared channel')

assert.deepStrictEqual(messages, ['shared channel'])
assert.equal(firstChannel.hasSubscribers, true)

secondChannel.unsubscribe(onMessage)
