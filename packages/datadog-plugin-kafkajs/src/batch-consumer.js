'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { getMessageSize } = require('../../dd-trace/src/datastreams')
const { convertToTextMap } = require('./utils')

const MESSAGING_DESTINATION_KEY = 'messaging.destination.name'

class KafkajsBatchConsumerPlugin extends ConsumerPlugin {
  static id = 'kafkajs'
  static operation = 'consume-batch'

  bindStart (ctx) {
    const { topic, partition, messages, groupId, clusterId } = ctx.extractedArgs || ctx

    // Extract parent context from first message headers if available
    let childOf
    if (messages && messages.length > 0 && messages[0]?.headers) {
      const headers = convertToTextMap(messages[0].headers)
      if (headers) {
        childOf = this.tracer.extract('text_map', headers)
      }
    }

    const span = this.startSpan({
      childOf,
      resource: topic,
      type: 'worker',
      meta: {
        component: this.constructor.id,
        'kafka.topic': topic,
        'kafka.cluster_id': clusterId,
        [MESSAGING_DESTINATION_KEY]: topic
      },
      metrics: {
        'kafka.partition': partition,
        'kafka.batch_size': messages ? messages.length : 0
      }
    }, ctx)

    // Add offset tags from first and last message in batch
    if (messages && messages.length > 0) {
      if (messages[0]?.offset) {
        span.setTag('kafka.first_offset', messages[0].offset)
      }
      if (messages[messages.length - 1]?.offset) {
        span.setTag('kafka.last_offset', messages[messages.length - 1].offset)
      }
    }

    // Data Streams Monitoring: process each message in the batch
    if (this.config.dsmEnabled) {
      for (const message of messages) {
        if (!message || !message.headers) continue
        const headers = convertToTextMap(message.headers)
        const payloadSize = getMessageSize(message)
        this.tracer.decodeDataStreamsContext(headers)
        const edgeTags = ['direction:in', `group:${groupId}`, `topic:${topic}`, 'type:kafka']
        if (clusterId) {
          edgeTags.push(`kafka_cluster_id:${clusterId}`)
        }
        this.tracer.setCheckpoint(edgeTags, span, payloadSize)
      }
    }

    return ctx.currentStore
  }
}

module.exports = KafkajsBatchConsumerPlugin
