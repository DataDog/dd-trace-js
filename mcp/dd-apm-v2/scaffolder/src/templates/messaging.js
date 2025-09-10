'use strict'

/**
 * Messaging-specific templates for queue/message broker libraries
 * These templates generate CompositePlugin structure with producer/consumer separation
 */

function generateMessagingInstrumentation (integrationName, analysis) {
  return `'use strict'

const { addHook, channel } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

// Messaging-specific channels
const produceStartCh = channel('apm:${integrationName}:produce:start')
const produceFinishCh = channel('apm:${integrationName}:produce:finish')
const produceErrorCh = channel('apm:${integrationName}:produce:error')
const receiveStartCh = channel('apm:${integrationName}:receive:start')
const receiveFinishCh = channel('apm:${integrationName}:receive:finish')
const receiveErrorCh = channel('apm:${integrationName}:receive:error')

// Producer instrumentation
function makeWrapProduce() {
  return function wrapProduce(produceOriginal) {
    return function wrapped() {
      if (!produceStartCh.hasSubscribers) {
        return produceOriginal.apply(this, arguments)
      }
      const ctx = {}
      // TODO: Extract message data, queue name, routing key from arguments
      return produceStartCh.runStores(ctx, () => {
        try {
          const result = produceOriginal.apply(this, arguments)
          produceFinishCh.publish(ctx)
          return result
        } catch (error) {
          ctx.error = error
          produceErrorCh.publish(ctx)
          throw error
        }
      })
    }
  }
}

// Consumer instrumentation  
function makeWrapConsume() {
  return function wrapConsume(consumeOriginal) {
    return function wrapped() {
      if (!receiveStartCh.hasSubscribers) {
        return consumeOriginal.apply(this, arguments)
      }
      const ctx = {}
      // TODO: Extract message data, queue name from arguments
      return receiveStartCh.runStores(ctx, () => {
        try {
          const result = consumeOriginal.apply(this, arguments)
          receiveFinishCh.publish(ctx)
          return result
        } catch (error) {
          ctx.error = error
          receiveErrorCh.publish(ctx)
          throw error
        }
      })
    }
  }
}

// Hook registration for main package
addHook({ name: '${integrationName}', versions: ['>=0'] }, (mod) => {
  // TODO: Identify producer methods and wrap them
  // Common patterns: add, publish, send, enqueue, push
  ${analysis.methods.length > 0
    ? analysis.methods.map(method =>
        `  // TODO: shimmer.wrap(mod.prototype, '${method.name}', makeWrapProduce())`
      ).join('\n')
    : '  // TODO: No methods found in analysis - manual investigation needed'
  }
  
  // TODO: Identify consumer methods and wrap them  
  // Common patterns: process, consume, subscribe, receive, pop
  
  return mod
})

module.exports = {
  makeWrapProduce,
  makeWrapConsume
}
`
}

function generateMessagingPlugin (integrationName, analysis) {
  return `'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')

const ProducerPlugin = require('./producer')
const ConsumerPlugin = require('./consumer')

class ${integrationName.charAt(0).toUpperCase() + integrationName.slice(1)}Plugin extends CompositePlugin {
  static id = '${integrationName}'

  static get plugins () {
    return {
      producer: ProducerPlugin,
      consumer: ConsumerPlugin
    }
  }
}

module.exports = ${integrationName.charAt(0).toUpperCase() + integrationName.slice(1)}Plugin
`
}

function generateProducerPlugin (integrationName) {
  return `'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')

class ${integrationName.charAt(0).toUpperCase() + integrationName.slice(1)}ProducerPlugin extends ProducerPlugin {
  static get id () {
    return '${integrationName}'
  }

  static get operation () {
    return 'send'
  }

  // TODO: Implement producer-specific tracing logic
  // TODO: Add span creation for message publishing
  // TODO: Handle message metadata and routing
}

module.exports = ${integrationName.charAt(0).toUpperCase() + integrationName.slice(1)}ProducerPlugin
`
}

function generateConsumerPlugin (integrationName) {
  return `'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')

class ${integrationName.charAt(0).toUpperCase() + integrationName.slice(1)}ConsumerPlugin extends ConsumerPlugin {
  static get id () {
    return '${integrationName}'
  }

  static get operation () {
    return 'receive'
  }

  // TODO: Implement consumer-specific tracing logic
  // TODO: Add span creation for message processing
  // TODO: Handle message acknowledgment and errors
}

module.exports = ${integrationName.charAt(0).toUpperCase() + integrationName.slice(1)}ConsumerPlugin
`
}

module.exports = {
  generateMessagingInstrumentation,
  generateMessagingPlugin,
  generateProducerPlugin,
  generateConsumerPlugin
}
