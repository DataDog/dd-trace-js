'use strict'

const dc = require('dc-polyfill')
const { getMessageSize } = require('../../dd-trace/src/datastreams/processor')
const { DsmPathwayCodec } = require('../../dd-trace/src/datastreams/pathway')
const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')

const afterStartCh = dc.channel('dd-trace:kafkajs:consumer:afterStart')
const beforeFinishCh = dc.channel('dd-trace:kafkajs:consumer:beforeFinish')

class KafkajsConsumerPlugin extends ConsumerPlugin {
  static get id () { return 'kafkajs' }
  static get operation () { return 'consume' }

  constructor () {
    super(...arguments)
    this.addSub('apm:kafkajs:consume:commit', message => this.commit(message))
  }

  /**
   * Transform individual commit details sent by kafkajs' event reporter
   * into actionable backlog items for DSM
   *
   * @typedef {object} ConsumerBacklog
   * @property {number} type
   * @property {string} consumer_group
   * @property {string} topic
   * @property {number} partition
   * @property {number} offset
   *
   * @typedef {object} CommitEventItem
   * @property {string} groupId
   * @property {string} topic
   * @property {number} partition
   * @property {import('kafkajs/utils/long').Long} offset
   *
   * @param {CommitEventItem} commit
   * @returns {ConsumerBacklog}
   */
  transformCommit (commit) {
    const { groupId, partition, offset, topic } = commit
    return {
      partition,
      topic,
      type: 'kafka_commit',
      offset: Number(offset),
      consumer_group: groupId
    }
  }

  commit (commitList) {
    if (!this.config.dsmEnabled) return
    const keys = [
      'consumer_group',
      'type',
      'partition',
      'offset',
      'topic'
    ]
    for (const commit of commitList.map(this.transformCommit)) {
      if (keys.some(key => !commit.hasOwnProperty(key))) continue
      this.tracer.setOffset(commit)
    }
  }

  start ({ topic, partition, message, groupId }) {
    const childOf = extract(this.tracer, message.headers)
    const span = this.startSpan({
      childOf,
      resource: topic,
      type: 'worker',
      meta: {
        component: 'kafkajs',
        'kafka.topic': topic,
        'kafka.message.offset': message.offset
      },
      metrics: {
        'kafka.partition': partition
      }
    })
    if (this.config.dsmEnabled && message?.headers && DsmPathwayCodec.contextExists(message.headers)) {
      const payloadSize = getMessageSize(message)
      this.tracer.decodeDataStreamsContext(message.headers)
      this.tracer
        .setCheckpoint(['direction:in', `group:${groupId}`, `topic:${topic}`, 'type:kafka'], span, payloadSize)
    }

    if (afterStartCh.hasSubscribers) {
      afterStartCh.publish({ topic, partition, message, groupId })
    }
  }

  finish () {
    if (beforeFinishCh.hasSubscribers) {
      beforeFinishCh.publish()
    }

    super.finish()
  }
}

function extract (tracer, bufferMap) {
  if (!bufferMap) return null

  const textMap = {}

  for (const key of Object.keys(bufferMap)) {
    if (bufferMap[key] === null || bufferMap[key] === undefined) continue

    textMap[key] = bufferMap[key].toString()
  }

  return tracer.extract('text_map', textMap)
}

module.exports = KafkajsConsumerPlugin
