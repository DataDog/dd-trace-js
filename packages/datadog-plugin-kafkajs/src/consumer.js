'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { getConnectionHash, getPathwayHash, encodePathwayCtx } = require('./hash')
const { LatencyStatsProcessor } = require('../../dd-trace/src/latency_stats')

class KafkajsConsumerPlugin extends ConsumerPlugin {
  static get id () { return 'kafkajs' }
  static get operation () { return 'consume' }

  start ({ topic, partition, message, groupId }) {
    const currentTs = Date.getTime()
    const childOf = extract(this.tracer, message.headers)
    let parentHash
    let pathwayHash
    let originTs
    const service = this.tracer._service
    if (this.config.DD_DATA_STREAMS_ENABLED !== 'disabled') {
      const env = this.tracer._env
      const checkpointString = getCheckpointString(service, env, groupId, topic, partition)
      const currentHash = getConnectionHash(checkpointString)

      if (message.headers.pathwayHash) {
        parentHash = 'PARENT_HASH'
        pathwayHash = getPathwayHash(parentHash, currentHash)
        originTs = 'ORIGIN_TS'
      } else {
        pathwayHash = currentHash
        originTs = currentTs
      }
    }

    const header = {
      childOf,
      service: this.config.service || `${service}-kafka`,
      resource: topic,
      kind: 'consumer',
      type: 'worker',
      meta: {
        'component': 'kafkajs',
        'kafka.topic': topic,
        'kafka.message.offset': message.offset,
        'pathwayhash': pathwayHash,
        'origintimestamp': originTs,
        'currenttimestamp': currentTs
      },
      metrics: {
        'kafka.partition': partition // TODO: send dsm values here
      }
    }

    const statsProcessor = LatencyStatsProcessor()

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
