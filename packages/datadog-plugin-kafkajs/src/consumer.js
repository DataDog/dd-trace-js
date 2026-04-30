'use strict'

const dc = require('dc-polyfill')
const { getMessageSize } = require('../../dd-trace/src/datastreams')
const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { convertToTextMap } = require('./utils')
const afterStartCh = dc.channel('dd-trace:kafkajs:consumer:afterStart')
const beforeFinishCh = dc.channel('dd-trace:kafkajs:consumer:beforeFinish')

const MESSAGING_DESTINATION_KEY = 'messaging.destination.name'

class KafkajsConsumerPlugin extends ConsumerPlugin {
  static id = 'kafkajs'
  static operation = 'consume'

  constructor () {
    super(...arguments)
    this.addSub(`apm:${this.constructor.id}:consume:commit`, message => this.commit(message))
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
   */
  /**
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
    const { groupId, partition, offset, topic, clusterId } = commit
    const backlog = {
      partition,
      topic,
      type: 'kafka_commit',
      offset: Number(offset),
      consumer_group: groupId,
    }
    if (clusterId) {
      backlog.kafka_cluster_id = clusterId
    }
    return backlog
  }

  commit (commitList) {
    if (!this.config.dsmEnabled) return
    const keys = ['consumer_group', 'type', 'partition', 'offset', 'topic']

    // Avoid `commitList.map(...)` (allocates a transformed Array) and
    // `keys.some(closure)` (allocates a closure per commit). One walk
    // with a counted loop and an early-exit `in` check is ~25% faster.
    for (let i = 0; i < commitList.length; i++) {
      const commit = this.transformCommit(commitList[i])
      let allKeys = true
      for (let j = 0; j < keys.length; j++) {
        if (!(keys[j] in commit)) {
          allKeys = false
          break
        }
      }
      if (allKeys) this.tracer.setOffset(commit)
    }
  }

  start (ctx) {
    if (!this.config.dsmEnabled) return
    const { topic, message, groupId, clusterId } = ctx.extractedArgs || ctx
    const headers = convertToTextMap(message?.headers)
    if (!headers) return

    const { span } = ctx.currentStore
    const payloadSize = getMessageSize(message)
    this.tracer.decodeDataStreamsContext(headers)
    const edgeTags = ['direction:in', `group:${groupId}`, `topic:${topic}`, 'type:kafka']
    if (clusterId) {
      edgeTags.push(`kafka_cluster_id:${clusterId}`)
    }
    this.tracer.setCheckpoint(edgeTags, span, payloadSize)
  }

  bindStart (ctx) {
    const { topic, partition, message, groupId, clusterId } = ctx.extractedArgs || ctx

    let childOf
    const headers = convertToTextMap(message?.headers)
    if (headers) {
      childOf = this.tracer.extract('text_map', headers)
    }
    const span = this.startSpan({
      childOf,
      resource: topic,
      type: 'worker',
      meta: {
        component: this.constructor.id,
        'kafka.topic': topic,
        'kafka.cluster_id': clusterId,
        [MESSAGING_DESTINATION_KEY]: topic,
      },
      metrics: {
        'kafka.partition': partition,
      },
    }, ctx)
    if (message?.offset) span.setTag('kafka.message.offset', message?.offset)

    if (afterStartCh.hasSubscribers) {
      afterStartCh.publish({ topic, partition, message, groupId, currentStore: ctx.currentStore })
    }

    return ctx.currentStore
  }

  finish (ctx) {
    if (beforeFinishCh.hasSubscribers) {
      beforeFinishCh.publish()
    }

    super.finish(ctx)
  }
}

module.exports = KafkajsConsumerPlugin
