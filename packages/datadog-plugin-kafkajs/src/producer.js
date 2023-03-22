'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { getConnectionHash, getPathwayHash, encodePathwayCtx } = require('./hash')

class KafkajsProducerPlugin extends ProducerPlugin {
  static get name () { return 'kafkajs' }
  static get operation () { return 'produce' }

  start ({ topic, messages }) {
    const env = this.tracer._env
    const service = this.tracer._service

    const active = this.activeSpan
    let parentHash
    let originTs
    let pathwayHash
    const checkpointString = getCheckpointString(service, env, topic)
    const currentHash = getConnectionHash(checkpointString)
    if (active) {
      const context = active.context()
      const rootSpan = context._trace.started[0]
      parentHash = rootSpan._spanContext._tags.pathwayHash
      originTs = rootSpan._spanContext._tags.originTs
      pathwayHash = getPathwayHash(parentHash, currentHash)
    } else {
      pathwayHash = currentHash
      originTs = currentHash
    }

    const currentTs = Date.now()

    const span = this.startSpan('kafka.produce', {
      service: this.config.service || `${this.tracer._service}-kafka`,
      resource: topic,
      kind: 'producer',
      meta: {
        'component': 'kafkajs',
        'kafka.topic': topic,
        'dd-pathway-ctx': encodePathwayCtx(pathwayHash, originTs, currentTs)
      },
      metrics: {
        'kafka.batch_size': messages.length
      }
    })

    for (const message of messages) {
      message.headers.pathwayHash = pathwayHash
      if (typeof message === 'object') {
        this.tracer.inject(span, 'text_map', message.headers)
      }
    }
  }
}

function getCheckpointString (service, env, topic, partition) {
  return `${service}${env}direction:outtopic:${topic}type:kafka`
}

module.exports = KafkajsProducerPlugin
