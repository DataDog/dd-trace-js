'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { DsmPathwayCodec } = require('../../dd-trace/src/datastreams')
const { getPayloadSize } = require('./payload-size')

/**
 * @typedef {object} BullQueue
 * @property {string} [name]
 *
 * @typedef {object} BullJobOpts
 * @property {Record<string, string>} [_datadog] Text-map carrier injected by this plugin.
 *
 * @typedef {object} BullJobSpec
 * @property {unknown} data
 * @property {string} [name]
 * @property {BullJobOpts} [opts]
 *
 * @typedef {object} BullProducedJob
 * @property {unknown} data
 * @property {BullJobOpts} opts
 *
 * @typedef {object} BullStore
 * @property {import('../../dd-trace/src/opentracing/span')} [span]
 *
 * @typedef {object} BullJobCreateContext
 * @property {[BullQueue, ...unknown[]]} arguments
 * @property {BullStore} [currentStore]
 * @property {BullProducedJob[]} [bullJobs]
 *
 * @typedef {object} BullJobCreateBulkContext
 * @property {[BullQueue, BullJobSpec[]]} arguments
 * @property {BullStore} [currentStore]
 * @property {BullProducedJob[]} [bullJobs]
 */

class BullJobCreatePlugin extends ProducerPlugin {
  static id = 'bull'
  static prefix = 'tracing:orchestrion:bull:Job_create'

  /**
   * @param {BullJobCreateContext} ctx
   * @returns {BullStore | undefined}
   */
  bindStart (ctx) {
    const args = ctx.arguments
    const queueName = args[0]?.name
    const span = this.startJobSpan(ctx, queueName)

    const optsIndex = typeof args[1] === 'string' ? 3 : 2
    const opts = /** @type {Record<string, unknown> | undefined} */ (args[optsIndex])
    const job = { data: args[optsIndex - 1], opts: this.inject(span, opts) }
    if (args.length <= optsIndex) args.length = optsIndex + 1
    args[optsIndex] = job.opts
    ctx.bullJobs = [job]

    return ctx.currentStore
  }

  /**
   * @param {BullJobCreateContext} ctx
   */
  start (ctx) {
    const span = ctx.currentStore?.span
    if (!this.config.dsmEnabled || !span || !ctx.bullJobs) return

    const edgeTags = ['direction:out', `topic:${ctx.arguments[0]?.name}`, 'type:bull']
    for (const { data, opts } of ctx.bullJobs) {
      const dataStreamsContext = this.tracer.setCheckpoint(edgeTags, span, getPayloadSize(data))
      DsmPathwayCodec.encode(dataStreamsContext, opts._datadog)
    }
  }

  /**
   * @param {BullJobCreateContext} ctx
   */
  asyncEnd (ctx) {
    ctx.currentStore?.span?.finish()
  }

  /**
   * @param {import('../../dd-trace/src/opentracing/span')} span
   * @param {Record<string, unknown> | undefined} opts
   * @returns {BullJobOpts}
   */
  inject (span, opts) {
    const carrier = /** @type {Record<string, string>} */ ({})
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

  /**
   * @param {BullJobCreateBulkContext} ctx
   * @returns {BullStore | undefined}
   */
  bindStart (ctx) {
    const jobs = Array.isArray(ctx.arguments[1]) ? ctx.arguments[1].filter(Boolean) : []
    const span = this.startJobSpan(ctx, ctx.arguments[0]?.name, {
      'messaging.batch.message_count': jobs.length,
    })

    for (const job of jobs) {
      job.opts = this.inject(span, job.opts)
    }
    ctx.bullJobs = /** @type {BullProducedJob[]} */ (jobs)

    return ctx.currentStore
  }
}

module.exports = [BullJobCreatePlugin, BullJobCreateBulkPlugin]
