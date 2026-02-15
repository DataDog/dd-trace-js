'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { getMessageSize } = require('../../dd-trace/src/datastreams')
const { convertToTextMap } = require('./utils')

class KafkajsBatchConsumerPlugin extends ConsumerPlugin {
  static id = 'kafkajs'
  static operation = 'consume-batch'

  bindStart (ctx) {
    const { topic, partition, messages, groupId, clusterId } = ctx.extractedArgs || ctx

    const span = this.startSpan({
      resource: topic,
      type: 'worker',
      meta: {
        component: this.constructor.id,
        'kafka.topic': topic,
        'kafka.cluster_id': clusterId,
        'messaging.destination.name': topic,
        'messaging.system': 'kafka',
      },
      metrics: {
        'kafka.partition': partition,
        'messaging.batch.message_count': messages.length,
      },
    }, ctx)

    for (const message of messages) {
      if (!message || !message.headers) continue

      const headers = convertToTextMap(message.headers)
      if (headers) {
        const childOf = this.tracer.extract('text_map', headers)
        span.addLink(childOf)
      }

      if (!this.config.dsmEnabled) continue
      const payloadSize = getMessageSize(message)
      this.tracer.decodeDataStreamsContext(headers)
      const edgeTags = ['direction:in', `group:${groupId}`, `topic:${topic}`, 'type:kafka']
      if (clusterId) {
        edgeTags.push(`kafka_cluster_id:${clusterId}`)
      }
      this.tracer.setCheckpoint(edgeTags, null, payloadSize)
    }

    return ctx.currentStore
  }
}

module.exports = KafkajsBatchConsumerPlugin
