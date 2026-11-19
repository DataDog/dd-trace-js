'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const Plugin = require('../../dd-trace/src/plugins/plugin')
const { getPayloadSize } = require('./payload-size')

const spans = new WeakMap()

class BullProcessJobPlugin extends ConsumerPlugin {
  static id = 'bull'
  static prefix = 'tracing:orchestrion:bull:Queue_processJob'

  bindStart (ctx) {
    const job = ctx.arguments[0]
    if (!job) return ctx.currentStore

    const queueName = job.queue?.name ?? ctx.self?.name
    const carrier = job.opts?._datadog

    const span = this.startSpan({
      childOf: carrier ? this.tracer.extract('text_map', carrier) : undefined,
      resource: queueName,
      meta: {
        component: 'bull',
        'messaging.system': 'bull',
        'messaging.destination.name': queueName,
        'messaging.operation': 'process',
      },
    }, ctx)
    spans.set(job, span)

    return ctx.currentStore
  }

  start (ctx) {
    const job = ctx.arguments[0]
    const span = ctx.currentStore?.span
    if (!this.config.dsmEnabled || !job || !span) return

    this.tracer.decodeDataStreamsContext(job.opts?._datadog)
    const queueName = job.queue?.name ?? ctx.self?.name
    this.tracer.setCheckpoint(['direction:in', `topic:${queueName}`, 'type:bull'], span, getPayloadSize(job.data))
  }

  asyncEnd (ctx) {
    ctx.currentStore?.span?.finish()
  }
}

class BullJobMoveToFailedPlugin extends Plugin {
  static id = 'bull'

  constructor (...args) {
    super(...args)
    this.addSub('tracing:orchestrion:bull:Job_moveToFailed:start', ({ self, arguments: [error] }) => {
      const span = spans.get(self)
      if (span && error && !span.context().getTag('error')) span.setTag('error', error)
    })
  }
}

module.exports = [BullProcessJobPlugin, BullJobMoveToFailedPlugin]
