'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { DsmPathwayCodec } = require('../../dd-trace/src/datastreams')
const { getPayloadSize } = require('./payload-size')

class BullJobCreatePlugin extends ProducerPlugin {
  static id = 'bull'
  static prefix = 'tracing:orchestrion:bull:Job_create'

  bindStart (ctx) {
    const args = ctx.arguments
    const queueName = args[0]?.name
    const span = this.startJobSpan(ctx, queueName)

    const optsIndex = typeof args[1] === 'string' ? 3 : 2
    const job = { data: args[optsIndex - 1], opts: this.inject(span, args[optsIndex]) }
    if (args.length <= optsIndex) args.length = optsIndex + 1
    args[optsIndex] = job.opts
    ctx.bullJobs = [job]

    return ctx.currentStore
  }

  start (ctx) {
    const span = ctx.currentStore?.span
    if (!this.config.dsmEnabled || !span || !ctx.bullJobs) return

    const edgeTags = ['direction:out', `topic:${ctx.arguments[0]?.name}`, 'type:bull']
    for (const { data, opts } of ctx.bullJobs) {
      const dataStreamsContext = this.tracer.setCheckpoint(edgeTags, span, getPayloadSize(data))
      DsmPathwayCodec.encode(dataStreamsContext, opts._datadog)
    }
  }

  asyncEnd (ctx) {
    ctx.currentStore?.span?.finish()
  }

  /**
   * @param {import('../../dd-trace/src/opentracing/span')} span
   * @param {Record<string, unknown> | undefined} opts
   * @returns {Record<string, unknown>}
   */
  inject (span, opts) {
    const carrier = {}
    this.tracer.inject(span, 'text_map', carrier)
    return { ...opts, _datadog: carrier }
  }

  /**
   * @param {object} ctx
   * @param {string | undefined} queueName
   * @param {Record<string, number>} [metrics]
   * @returns {import('../../dd-trace/src/opentracing/span')}
   */
  startJobSpan (ctx, queueName, metrics) {
    return this.startSpan({
      resource: queueName,
      meta: {
        component: 'bull',
        'messaging.system': 'bull',
        'messaging.destination.name': queueName,
        'messaging.operation': 'publish',
      },
      metrics,
    }, ctx)
  }
}

class BullJobCreateBulkPlugin extends BullJobCreatePlugin {
  static prefix = 'tracing:orchestrion:bull:Job_createBulk'

  operationName () {
    return 'bull.addBulk'
  }

  bindStart (ctx) {
    const jobs = Array.isArray(ctx.arguments[1]) ? ctx.arguments[1].filter(Boolean) : []
    const span = this.startJobSpan(ctx, ctx.arguments[0]?.name, {
      'messaging.batch.message_count': jobs.length,
    })

    for (const job of jobs) {
      job.opts = this.inject(span, job.opts)
    }
    ctx.bullJobs = jobs

    return ctx.currentStore
  }
}

module.exports = [BullJobCreatePlugin, BullJobCreateBulkPlugin]
