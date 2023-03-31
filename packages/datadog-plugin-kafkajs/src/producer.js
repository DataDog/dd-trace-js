'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { getPathwayHash, encodePathwayContext, decodePathwayContext } = require('./hash')

const ENTRY_PARENT_HASH = Buffer.from('0000000000000000', 'hex')

class KafkajsProducerPlugin extends ProducerPlugin {
  static get id () { return 'kafkajs' }
  static get operation () { return 'produce' }

  start ({ topic, messages }) {
    const env = this.tracer._env
    const service = this.tracer._service

    let pathwayCtx
    if (this.config.dsmEnabled) {
      const active = this.activeSpan
      let parentHash
      let originTimestamp
      let prevTimestamp
      const currentTimestamp = new Date().now() * 1000000 // nanoseconds
      const checkpointString = getCheckpointString(service, env, topic)
      if (active) {
        const context = active.context()
        const rootSpan = context._trace.started[0];
        // TODO
        [parentHash, originTimestamp, prevTimestamp] = decodePathwayContext(rootSpan._spanContext._tags.pathwayHash)
      } else {
        parentHash = ENTRY_PARENT_HASH
        originTimestamp = currentTimestamp
        prevTimestamp = currentTimestamp
      }
      const pathwayHash = getPathwayHash(checkpointString, parentHash)

      const edgeLatency = currentTimestamp - prevTimestamp
      const pathwayLatency = currentTimestamp - originTimestamp
      pathwayCtx = encodePathwayContext(pathwayHash, originTimestamp, prevTimestamp)

      const checkpoint = {
        currentTimestamp: currentTimestamp,
        metrics: {
          'parentHash': parentHash,
          'edgeTags': { 'service': service, 'env': env, 'topic': topic },
          'dd-pathway-ctx': pathwayCtx,
          'edgeLatency': edgeLatency,
          'pathwayLatency': pathwayLatency
        }
      }

      this.config.latencyStatsProcessor.recordCheckpoint(checkpoint)
    }

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
        if (this.config.dsmEnabled) message.headers['dd-pathway-ctx'] = pathwayCtx
        this.tracer.inject(span, 'text_map', message.headers)
      }
    }
  }
}

function getCheckpointString (service, env, topic, partition) {
  return `${service}${env}direction:outtopic:${topic}type:kafka`
}

module.exports = KafkajsProducerPlugin
