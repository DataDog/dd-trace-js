'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const ProducerPlugin = require('../../dd-trace/src/plugins/producer')

class ElectronIpcPlugin extends CompositePlugin {
  static id = 'electron:ipc'
  static get plugins () {
    return {
      main: ElectronMainPlugin,
      renderer: ElectronRendererPlugin
    }
  }
}

class ElectronMainPlugin extends CompositePlugin {
  static id = 'electron:ipc:main'
  static get plugins () {
    return {
      receive: ElectronMainReceivePlugin,
      send: ElectronMainSendPlugin
    }
  }
}

class ElectronRendererPlugin extends CompositePlugin {
  static id = 'electron:ipc:renderer'
  static get plugins () {
    return {
      receive: ElectronRendererReceivePlugin,
      send: ElectronRendererSendPlugin
    }
  }
}

class ElectronRendererReceivePlugin extends ConsumerPlugin {
  static id = 'electron:ipc:renderer:receive'
  static component = 'electron'
  static operation = 'receive'
  static prefix = 'tracing:apm:electron:ipc:renderer:receive'

  bindStart (ctx) {
    const { args, channel } = ctx

    if (channel?.startsWith('datadog:')) return

    const childOf = this._tracer.extract('text_map', args[args.length - 1])

    if (childOf) {
      args.pop()
    }

    this.startSpan({
      childOf,
      resource: channel,
      type: 'worker',
      meta: {}
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    this.finish(ctx)
  }
}

class ElectronRendererSendPlugin extends ProducerPlugin {
  static id = 'electron:ipc:renderer:send'
  static component = 'electron'
  static operation = 'send'
  static prefix = 'tracing:apm:electron:ipc:renderer:send'

  bindStart (ctx) {
    const { args, channel } = ctx

    if (channel?.startsWith('datadog:')) return

    const span = this.startSpan({
      resource: channel,
      meta: {}
    }, ctx)

    if (this._shouldInject(ctx)) {
      const carrier = {}

      this._tracer.inject(span, 'text_map', carrier)

      args.push(carrier)
    }

    return ctx.currentStore
  }

  end (ctx) {
    if (ctx.hasOwnProperty('result')) {
      this.finish(ctx)
    }
  }

  asyncEnd (ctx) {
    this.finish(ctx)
  }

  // Renderer can always inject since main is guaranteed to be patched.
  _shouldInject () {
    return true
  }
}

class ElectronMainReceivePlugin extends ElectronRendererReceivePlugin {
  static id = 'electron:ipc:main:receive'
  static prefix = 'tracing:apm:electron:ipc:main:receive'
}

class ElectronMainSendPlugin extends ElectronRendererSendPlugin {
  static id = 'electron:ipc:main:send'
  static prefix = 'tracing:apm:electron:ipc:main:send'

  constructor (...args) {
    super(...args)

    this._renderers = new WeakSet()

    this.addSub('apm:electron:ipc:renderer:patched', event => {
      this._renderers.add(event.sender)
    })
  }

  // Only inject when the renderer was patched.
  _shouldInject ({ self }) {
    return this._renderers.has(self)
  }
}

module.exports = ElectronIpcPlugin
