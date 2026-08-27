'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const {
  identityService,
  integrationService,
  integrationServiceSource,
  noServiceSource,
} = require('../../dd-trace/src/service-naming/helpers')
const { convertToTextMap, getKafkaMessageSize } = require('./utils')

/** @type {import('../../dd-trace/src/plugins/tracing').NamingSchema} */
const namingSchema = {
  v0: {
    operationName: () => 'kafka.consume',
    serviceName: integrationService('kafka'),
    serviceSource: integrationServiceSource('kafka'),
  },
  v1: {
    operationName: () => 'kafka.process',
    serviceName: identityService,
    serviceSource: noServiceSource,
  },
}

class KafkajsBatchConsumerPlugin extends ConsumerPlugin {
  static id = 'kafkajs'
  static operation = 'consume-batch'

  /** @override */
  getNamingSchema () {
    return namingSchema
  }

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
