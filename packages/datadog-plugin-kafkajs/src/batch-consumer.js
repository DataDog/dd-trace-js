'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const {
  convertToTextMap,
  getClusterIdEdgeTag,
  getGroupEdgeTag,
  getKafkaMessageSize,
  getTopicEdgeTag,
} = require('./utils')

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
        if (childOf) {
          span.addLink({ context: childOf })
        }
      }

      if (!this.config.dsmEnabled) continue
      const payloadSize = getKafkaMessageSize(message)
      // Sorted order, see utils.js.
      const edgeTags = clusterId
        ? [
            'direction:in',
            getGroupEdgeTag(groupId),
            getClusterIdEdgeTag(clusterId),
            getTopicEdgeTag(topic),
            'type:kafka',
          ]
        : ['direction:in', getGroupEdgeTag(groupId), getTopicEdgeTag(topic), 'type:kafka']
      this.tracer._decodeAndSetCheckpoint(headers, edgeTags, null, payloadSize)
    }

    return ctx.currentStore
  }
}

module.exports = KafkajsBatchConsumerPlugin
