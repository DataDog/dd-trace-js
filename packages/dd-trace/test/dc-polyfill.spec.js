'use strict'

const assert = require('node:assert/strict')

const vendoredDc = require('../../../vendor/dist/dc-polyfill')

describe('vendored dc-polyfill', () => {
  const userCopies = {
    direct: require('dc-polyfill'),
    transitive: require('../../../vendor/node_modules/dc-polyfill'),
  }

  for (const [dependencyType, userDc] of Object.entries(userCopies)) {
    it(`shares channels with a user ${dependencyType} dependency`, () => {
      const channelName = `dd-trace:test:dc-polyfill:${dependencyType}`
      const userMessages = []
      const vendoredMessages = []
      const onUserMessage = message => userMessages.push(message)
      const onVendoredMessage = message => vendoredMessages.push(message)
      const userChannel = userDc.channel(channelName)
      const vendoredChannel = vendoredDc.channel(channelName)

      userChannel.subscribe(onUserMessage)
      vendoredChannel.publish('from vendored')
      vendoredChannel.subscribe(onVendoredMessage)
      userChannel.publish('from user')

      assert.deepStrictEqual(userMessages, ['from vendored', 'from user'])
      assert.deepStrictEqual(vendoredMessages, ['from user'])

      userChannel.unsubscribe(onUserMessage)
      vendoredChannel.unsubscribe(onVendoredMessage)
    })

    it(`shares tracing channels with a user ${dependencyType} dependency`, () => {
      const channelName = `dd-trace:test:dc-polyfill:tracing:${dependencyType}`
      const contexts = []
      const handlers = { start: context => contexts.push(context) }
      const userTracingChannel = userDc.tracingChannel(channelName)

      userTracingChannel.subscribe(handlers)
      vendoredDc.tracingChannel(channelName).traceSync(() => 'result')

      assert.deepStrictEqual(contexts, [{ result: 'result' }])

      userTracingChannel.unsubscribe(handlers)
    })
  }
})
