'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

class KafkajsPlugin extends Plugin {
  static get name () {
    return 'kafkajs'
  }

  constructor (...args) {
    super(...args)

    this.addSub(`apm:kafkajs:produce:start`, ({ topic, messages }) => {
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const span = this.tracer.startSpan('kafka.produce', {
        childOf,
        tags: {
          'service.name': this.config.service || `${this.tracer._service}-kafka`,
          'span.kind': 'producer',
          'component': 'kafkajs'
        }
      })

      analyticsSampler.sample(span, this.config.measured)
      this.enter(span, store)

      span.addTags({
        'resource.name': topic,
        'kafka.topic': topic,
        'kafka.batch_size': messages.length
      })
      for (const message of messages) {
        if (typeof message === 'object') {
          this.tracer.inject(span, 'text_map', message.headers)
        }
      }
    })

    this.addSub(`apm:kafkajs:consume:start`, ({ topic, partition, message }) => {
      const store = storage.getStore()
      const childOf = extract(this.tracer, message.headers)
      const span = this.tracer.startSpan('kafka.consume', {
        childOf,
        tags: {
          'service.name': this.config.service || `${this.tracer._service}-kafka`,
          'span.kind': 'consumer',
          'span.type': 'worker',
          'component': 'kafkajs',
          'resource.name': topic,
          'kafka.topic': topic,
          'kafka.partition': partition,
          'kafka.message.offset': message.offset
        }
      })

      analyticsSampler.sample(span, this.config.measured, true)
      this.enter(span, store)
    })

    this.addSub(`apm:kafkajs:consume:error`, errorHandler)

    this.addSub(`apm:kafkajs:consume:finish`, finishHandler)

    this.addSub(`apm:kafkajs:produce:error`, errorHandler)

    this.addSub(`apm:kafkajs:produce:finish`, finishHandler)
  }
}

function finishHandler () {
  storage.getStore().span.finish()
}

function errorHandler (error) {
  storage.getStore().span.setTag('error', error)
}

function extract (tracer, bufferMap) {
  if (!bufferMap) return null

  const textMap = {}

  for (const key of Object.keys(bufferMap)) {
    textMap[key] = bufferMap[key].toString()
  }

  return tracer.extract('text_map', textMap)
}

module.exports = KafkajsPlugin
