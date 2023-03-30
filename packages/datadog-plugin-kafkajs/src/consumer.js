'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { getPathwayHash, encodePathwayContext, decodePathwayContext } = require('./hash')

class KafkajsConsumerPlugin extends ConsumerPlugin {
  static get id () { return 'kafkajs' }
  static get operation () { return 'consume' }

  start ({ topic, partition, message, groupId }) {
    const currentTime = new Date().now()
    const childOf = extract(this.tracer, message.headers)
    let parentHash
    let pathwayHash
    let originTime
    let prevTime
    const service = this.tracer._service
    if (this.config.dsmEnabled !== 'disabled') {
      const env = this.tracer._env
      const checkpointString = getCheckpointString(service, env, groupId, topic, partition)
      const pathwayHash = getPathwayHash(checkpointString, parentHash)

      const prevPathwayCtx = message.headers['dd-pathway-ctx']
      if (prevPathwayCtx) {
        [parentHash, originTimestamp, prevTimestamp] = decodePathwayContext(rootSpan._spanContext._tags.pathwayHash)
      } else {
        pathwayHash = currentHash
        originTime = currentTime
        prevTime = currentTime
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
        'kafka.message.offset': message.offset
      },
      metrics: {
        'kafka.partition': partition, // TODO: send dsm values here
        'dd-pathway-ctx': 'TODO',
        'pathwayhash': pathwayHash,
        'origintimestamp': originTime,
        'currenttimestamp': currentTime,
        'edgeLatency': currentTime - prevTime,
        'pathwayLatency': currentTime - originTime
      }
    }

    this.config.latencyStatsProcessor.onFinished(header)

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
