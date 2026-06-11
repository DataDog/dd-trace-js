'use strict'

const { tracingChannel, channel } = require('dc-polyfill')

const mainReceiveCh = tracingChannel('apm:electron:ipc:main:receive')
const mainHandleCh = tracingChannel('apm:electron:ipc:main:handle')
const mainSendCh = tracingChannel('apm:electron:ipc:main:send')
const rendererPatchedCh = channel('apm:electron:ipc:renderer:patched')
const rendererReceiveCh = tracingChannel('apm:electron:ipc:renderer:receive')
const rendererSendCh = tracingChannel('apm:electron:ipc:renderer:send')

// Lazy-load tracer to avoid requiring dd-trace at module load time
// when the renderer process may not have it available.
function getTracer () {
  // eslint-disable-next-line n/no-missing-require
  return require('dd-trace')
}

const renderers = new WeakSet()

rendererPatchedCh.subscribe(event => {
  renderers.add(event.sender)
})

function subscribeReceive (ch, spanName) {
  ch.start.subscribe(ctx => {
    const { args, channel: ipcChannel } = ctx

    if (ipcChannel?.startsWith('datadog:')) return

    const tracer = getTracer()
    const childOf = tracer.extract('text_map', args[args.length - 1])

    if (childOf) {
      args.pop()
    }

    const span = tracer.startSpan(spanName, {
      childOf,
      tags: {
        'span.kind': 'consumer',
        component: 'electron',
        'resource.name': ipcChannel,
        type: 'worker',
      },
    })

    ctx._span = span
    ctx.currentStore = tracer.scope().activate(span)
  })

  ch.asyncEnd.subscribe(ctx => {
    ctx._span?.finish()
  })

  ch.error.subscribe(ctx => {
    if (ctx._span) {
      ctx._span.setTag('error', ctx.error)
    }
  })
}

function subscribeSend (ch, spanName, shouldInject) {
  ch.start.subscribe(ctx => {
    const { args, channel: ipcChannel } = ctx

    if (ipcChannel?.startsWith('datadog:')) return

    const tracer = getTracer()
    const span = tracer.startSpan(spanName, {
      tags: {
        'span.kind': 'producer',
        component: 'electron',
        'resource.name': ipcChannel,
      },
    })

    ctx._span = span
    ctx.currentStore = tracer.scope().activate(span)

    if (shouldInject(ctx)) {
      const carrier = {}
      tracer.inject(span, 'text_map', carrier)
      args.push(carrier)
    }
  })

  ch.end.subscribe(ctx => {
    if (ctx.hasOwnProperty('result')) {
      ctx._span?.finish()
    }
  })

  ch.asyncEnd.subscribe(ctx => {
    ctx._span?.finish()
  })

  ch.error.subscribe(ctx => {
    if (ctx._span) {
      ctx._span.setTag('error', ctx.error)
    }
  })
}

subscribeReceive(mainReceiveCh, 'electron.main.receive')
subscribeReceive(mainHandleCh, 'electron.main.handle')
subscribeSend(mainSendCh, 'electron.main.send', ({ self }) => renderers.has(self))

subscribeReceive(rendererReceiveCh, 'electron.renderer.receive')
// Renderer can always inject since main is guaranteed to be patched.
subscribeSend(rendererSendCh, 'electron.renderer.send', () => true)
