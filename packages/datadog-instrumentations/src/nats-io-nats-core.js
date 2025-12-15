'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

// Channels for publish operation
const publishStartCh = channel('apm:@nats-io/nats-core:natsconnectionimpl:prototype:publish:start')
const publishEndCh = channel('apm:@nats-io/nats-core:natsconnectionimpl:prototype:publish:end')
const publishErrorCh = channel('apm:@nats-io/nats-core:natsconnectionimpl:prototype:publish:error')

// Channels for request operation
const requestStartCh = channel('apm:@nats-io/nats-core:natsconnectionimpl:prototype:request:asyncStart')
const requestEndCh = channel('apm:@nats-io/nats-core:natsconnectionimpl:prototype:request:asyncEnd')
const requestErrorCh = channel('apm:@nats-io/nats-core:natsconnectionimpl:prototype:request:error')

// Channels for processMsg operation (consumer)
const processMsgStartCh = channel('apm:@nats-io/nats-core:protocolhandler:prototype:processmsg:start')
const processMsgEndCh = channel('apm:@nats-io/nats-core:protocolhandler:prototype:processmsg:end')
const processMsgErrorCh = channel('apm:@nats-io/nats-core:protocolhandler:prototype:processmsg:error')

addHook({ name: '@nats-io/nats-core', file: 'lib/nats.js', versions: ['>=3.2.0'] }, (natsExports) => {
  const NatsConnectionImpl = natsExports.NatsConnectionImpl
  const { headers: createHeaders } = natsExports

  if (!NatsConnectionImpl) return natsExports

  // Instrument publish (sync operation)
  shimmer.wrap(NatsConnectionImpl.prototype, 'publish', publish => function (subject, data, options) {
    if (!publishStartCh.hasSubscribers) {
      return publish.apply(this, arguments)
    }

    // Ensure options object exists for header injection
    if (!options) {
      options = {}
    }

    // Create NATS headers if they don't exist
    // This allows plugins to inject trace and DSM context
    if (!options.headers && createHeaders) {
      options.headers = createHeaders()
    }

    const ctx = {
      subject,
      data,
      options,
      self: this
    }

    try {
      publishStartCh.runStores(ctx, () => {
        try {
          ctx.result = publish.apply(this, [subject, data, options])
          publishEndCh.publish(ctx)
        } catch (error) {
          ctx.error = error
          publishErrorCh.publish(ctx)
          throw error
        }
      })
      return ctx.result
    } catch (error) {
      ctx.error = error
      publishErrorCh.publish(ctx)
      throw error
    }
  })

  // Instrument request (async operation)
  shimmer.wrap(NatsConnectionImpl.prototype, 'request', request => function (subject, data, options) {
    if (!requestStartCh.hasSubscribers) {
      return request.apply(this, arguments)
    }

    const ctx = {
      subject,
      data,
      options,
      self: this
    }

    requestStartCh.publish(ctx)

    const promise = request.apply(this, arguments)

    return promise.then(
      result => {
        ctx.result = result
        requestEndCh.publish(ctx)
        return result
      },
      error => {
        ctx.error = error
        requestErrorCh.publish(ctx)
        throw error
      }
    )
  })

  return natsExports
})

addHook({ name: '@nats-io/nats-core', file: 'lib/protocol.js', versions: ['>=3.2.0'] }, (protocolExports) => {
  const ProtocolHandler = protocolExports.ProtocolHandler

  if (!ProtocolHandler) return protocolExports

  // Instrument processMsg (sync consumer operation)
  shimmer.wrap(ProtocolHandler.prototype, 'processMsg', processMsg => function (msg, data) {
    if (!processMsgStartCh.hasSubscribers) {
      return processMsg.apply(this, arguments)
    }

    const ctx = {
      msg,
      data,
      self: this
    }

    try {
      processMsgStartCh.runStores(ctx, () => {
        try {
          ctx.result = processMsg.apply(this, arguments)
          processMsgEndCh.publish(ctx)
        } catch (error) {
          ctx.error = error
          processMsgErrorCh.publish(ctx)
          throw error
        }
      })
      return ctx.result
    } catch (error) {
      ctx.error = error
      processMsgErrorCh.publish(ctx)
      throw error
    }
  })

  return protocolExports
})
