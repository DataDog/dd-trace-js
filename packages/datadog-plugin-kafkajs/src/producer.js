'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { getPathwayHash, encodePathwayContext, decodePathwayContext } = require('./hash')

class KafkajsProducerPlugin extends ProducerPlugin {
  static get id () { return 'kafkajs' }
  static get operation () { return 'produce' }

  start ({ topic, messages }) {
    const env = this.tracer._env
    const service = this.tracer._service

    const active = this.activeSpan
    let parentHash
    let originTimestamp
    let pathwayHash
    let prevTimestamp
    const currentTimestamp = new Date().now()
    const checkpointString = getCheckpointString(service, env, topic)
    if (active) {
      const context = active.context()
      const rootSpan = context._trace.started[0];
      [parentHash, originTimestamp, prevTimestamp] = decodePathwayContext(rootSpan._spanContext._tags.pathwayHash)
    } else {
      parentHash = Buffer.from('0000000000000000', 'hex')
      originTimestamp = currentTimestamp
      prevTimestamp = currentTimestamp
    }
    pathwayHash = getPathwayHash(checkpointString, parentHash)

    const edgeLatency = currentTimestamp - prevTimestamp
    const pathwayLatency = currentTimestamp - originTimestamp

    const span = this.startSpan('kafka.produce', {
      service: this.config.service || `${this.tracer._service}-kafka`,
      resource: topic,
      kind: 'producer',
      meta: {
        'component': 'kafkajs',
        'kafka.topic': topic
      },
      metrics: {
        'kafka.batch_size': messages.length
      }
    })

    for (const message of messages) {
      if (typeof message === 'object') {
        message.headers['dd-pathway-ctx'] = encodePathwayContext(pathwayHash, originTimestamp, prevTimestamp)
        this.tracer.inject(span, 'text_map', message.headers)
      }
    }
  }
}

function getCheckpointString (service, env, topic, partition) {
  return `${service}${env}direction:outtopic:${topic}type:kafka`
}

module.exports = KafkajsProducerPlugin
