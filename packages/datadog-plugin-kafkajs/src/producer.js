'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const Hash = require('./hash')
const { encodePathwayContext } = require('./hash')

const ENTRY_PARENT_HASH = Buffer.from('0000000000000000', 'hex')

class KafkajsProducerPlugin extends ProducerPlugin {
  static get id () { return 'kafkajs' }
  static get operation () { return 'produce' }

  start ({ topic, messages }) {
    const env = this.tracer._env
    const service = this.tracer._service

    let pathwayCtx
    if (this.config.dsmEnabled) {
      // todo[piochelepiotr] How is context propagated in javascript? Especially in await/async functions?
      // let active
      // if (this.activeSpan.name == 'kafka.consume') {
      //   active = this.activeSpan.name
      // }
      let parentHash
      let pathwayStartNs
      let edgeStartNs
      const nowNs = Date.now() * 1e6
      const checkpointString = getCheckpointString(service, env, topic)
      // if (active) {
      //   console.log('ACTIVE SPAN', active)
      //   const rootSpan = active.context()._trace.started[0];
      //   [ parentHash, pathwayStartNs, edgeStartNs ] =
      //   Hash.decodePathwayContext(rootSpan._spanContext._tags.metrics['dd-pathway-ctx'])
      // } else {
      //   parentHash = ENTRY_PARENT_HASH
      //   pathwayStartNs = nowNs
      //   edgeStartNs = nowNs
      // }
      parentHash = ENTRY_PARENT_HASH
      pathwayStartNs = nowNs
      edgeStartNs = nowNs

      // todo[piochelepiotr] the hash computation should be done in the core tracer
      const hash = Hash.getPathwayHash(checkpointString, parentHash)

      const edgeLatencyNs = nowNs - edgeStartNs
      const pathwayLatencyNs = nowNs - pathwayStartNs
      // pathwayCtx = Hash.encodePathwayContext(pathwayHash, pathwayStartNs, nowNs)

      const checkpoint = {
        currentTimestamp: nowNs,
        parentHash: parentHash,
        hash: hash,
        edgeTags: ['direction:out', `topic:${topic}`, 'type:kafka'],
        edgeLatencyNs: edgeLatencyNs,
        pathwayLatencyNs: pathwayLatencyNs
      }
      this.config.dataStreamsProcessor.setCheckpoint()
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
        if (this.config.dsmEnabled) message.headers['dd-pathway-ctx'] = encodePathwayContext(hash, pathwayStartNs, edgeStatsNs)
        this.tracer.inject(span, 'text_map', message.headers)
      }
    }
  }
}

function getCheckpointString (service, env, topic) {
  return `${service}${env}direction:outtopic:${topic}type:kafka`
}

module.exports = KafkajsProducerPlugin
