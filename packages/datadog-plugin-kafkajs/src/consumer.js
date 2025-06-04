'use strict'

const dc = require('dc-polyfill')
const { getMessageSize } = require('../../dd-trace/src/datastreams')
const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { convertToTextMap } = require('./utils')
const afterStartCh = dc.channel('dd-trace:kafkajs:consumer:afterStart')
const beforeFinishCh = dc.channel('dd-trace:kafkajs:consumer:beforeFinish')

const MESSAGING_DESTINATION_KEY = 'messaging.destination.name'

class KafkajsConsumerPlugin extends ConsumerPlugin {
  static get id () { return 'kafkajs' }
  static get operation () { return 'consume' }

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
        [MESSAGING_DESTINATION_KEY]: topic
      },
      metrics: {
        'kafka.partition': partition
      }
    }, ctx)
    if (message?.offset) span.setTag('kafka.message.offset', message?.offset)

    if (this.config.dsmEnabled && headers) {
      const payloadSize = getMessageSize(message)
      this.tracer.decodeDataStreamsContext(headers)
      const edgeTags = ['direction:in', `group:${groupId}`, `topic:${topic}`, 'type:kafka']
      if (clusterId) {
        edgeTags.push(`kafka_cluster_id:${clusterId}`)
      }
      this.tracer.setCheckpoint(edgeTags, span, payloadSize)
    }

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
