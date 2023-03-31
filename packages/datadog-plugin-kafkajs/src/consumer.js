'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { getPathwayHash, encodePathwayContext, decodePathwayContext } = require('./hash')

const ENTRY_PARENT_HASH = Buffer.from('0000000000000000', 'hex')

class KafkajsConsumerPlugin extends ConsumerPlugin {
  static get id () { return 'kafkajs' }
  static get operation () { return 'consume' }

  start ({ topic, partition, message, groupId }) {
    const childOf = extract(this.tracer, message.headers)
    let parentHash
    let pathwayCtx
    let originTimestamp
    let prevTimestamp
    const service = this.tracer._service

    const header = {
      childOf,
      service: this.config.service || `${service}-kafka`,
      resource: topic,
      kind: 'consumer',
      type: 'worker',
      meta: {
        'component': 'kafkajs',
        'kafka.topic': topic,
        'kafka.message.offset': message.offset
      },
      metrics: {
        'kafka.partition': partition
      }
    }

    if (this.config.dsmEnabled) {
      const currentTimestamp = new Date().now() * 1000000 // nanoseconds
      const env = this.tracer._env
      const checkpointString = getCheckpointString(service, env, groupId, topic, partition)

      const prevPathwayCtx = message.headers['dd-pathway-ctx']
      if (prevPathwayCtx) {
        [parentHash, originTimestamp, prevTimestamp] = decodePathwayContext(message.headers['dd-pathway-ctx'])
      } else {
        parentHash = ENTRY_PARENT_HASH
        originTimestamp = currentTimestamp
        prevTimestamp = currentTimestamp
      }
      const pathwayHash = getPathwayHash(checkpointString, parentHash)
      const edgeLatency = currentTimestamp - prevTimestamp
      const pathwayLatency = currentTimestamp - originTimestamp
      pathwayCtx = encodePathwayContext(pathwayHash, originTimestamp, prevTimestamp)

      header.metrics['parentHash'] = parentHash
      header.metrics['edgeTags'] = {
        'service': service,
        'env': env,
        'groupId': groupId,
        'topic': topic,
        'partition': partition
      }
      header.metrics['edgeLatency'] = edgeLatency
      header.metrics['pathwayLatency'] = pathwayLatency
      header.metrics['dd-pathway-ctx'] = pathwayCtx
    }

    this.config.latencyStatsProcessor.recordCheckpoint(header)

    this.startSpan('kafka.consume', header)
  }
}

// split this into two
function extract (tracer, bufferMap) {
  if (!bufferMap) return null

  const textMap = {}

  for (const key of Object.keys(bufferMap)) {
    textMap[key] = bufferMap[key].toString()
  }

  return tracer.extract('text_map', textMap)
}

function getCheckpointString (service, env, groupId, topic, partition) {
  return `${service}${env}direction:ingroup:${groupId}partition:${partition}topic:${topic}type:kafka`
}

module.exports = KafkajsConsumerPlugin
