'use strict'

const analyticsSampler = require('../analytics_sampler')

function createWrapSend (tracer, config) {
  return function wrapSend (send) {
    return function sendWithTrace (msg, options) {
      const span = startSendSpan(tracer, config, this)

      try {
        const promise = tracer.scope().activate(span, () => {
          return send.apply(this, arguments)
        })

        return wrapPromise(promise, span)
      } catch (e) {
        finish(span, e)
        throw e
      }
    }
  }
}

function createWrapMessageReceived (tracer, config) {
  return function wrapMessageReceived (messageReceived) {
    return function messageReceivedWithTrace (transferFrame) {
      if (transferFrame.aborted || transferFrame.more) {
        return messageReceived.apply(this, arguments)
      }

      const span = startReceiveSpan(tracer, config, this)

      return tracer.scope().activate(span, () => {
        messageReceived.apply(this, arguments)
        span.finish()
      })
    }
  }
}

function startSendSpan (tracer, config, link) {
  const address = link.session.connection.address
  const target = getAddress(link)

  const span = tracer.startSpan(`amqp.send`, {
    tags: {
      'resource.name': `send ${target}`,
      'span.kind': 'producer',
      'amqp.link.target.address': target,
      'amqp.link.role': 'sender',
      'out.host': address.host,
      'out.port': address.port
    }
  })

  addTags(tracer, config, span, link)

  analyticsSampler.sample(span, config.analytics)

  return span
}

function startReceiveSpan (tracer, config, link) {
  const source = getAddress(link)
  const span = tracer.startSpan(`amqp.receive`, {
    tags: {
      'resource.name': `receive ${source}`,
      'span.kind': 'consumer',
      'amqp.link.source.address': source,
      'amqp.link.role': 'receiver'
    }
  })

  addTags(tracer, config, span, link)

  analyticsSampler.sample(span, config.analytics, true)

  return span
}

function addTags (tracer, config, span, link) {
  const address = link.session.connection.address

  span.addTags({
    'service.name': config.service || `${tracer._service}-amqp`,
    'span.type': 'worker',
    'amqp.link.name': link.name,
    'amqp.link.handle': link.handle,
    'amqp.connection.host': address.host,
    'amqp.connection.port': address.port
  })

  if (address.user) {
    span.setTag('amqp.connection.user', address.user)
  }

  return span
}

function finish (span, error) {
  if (error) {
    span.addTags({
      'error.type': error.name,
      'error.msg': error.message,
      'error.stack': error.stack
    })
  }

  span.finish()
}

function wrapPromise (promise, span) {
  if (!promise) {
    finish(span)
    return promise
  }

  promise.then(() => finish(span), e => finish(span, e))

  return promise
}

function getAddress (link) {
  return link.name.split('_').slice(0, -1).join('_')
}

module.exports = [
  {
    name: 'amqp10',
    file: 'lib/sender_link.js',
    versions: ['>=3'],
    patch (SenderLink, tracer, config) {
      this.wrap(SenderLink.prototype, 'send', createWrapSend(tracer, config))
    },
    unpatch (SenderLink) {
      this.unwrap(SenderLink.prototype, 'send')
    }
  },
  {
    name: 'amqp10',
    file: 'lib/receiver_link.js',
    versions: ['>=3'],
    patch (ReceiverLink, tracer, config) {
      this.wrap(ReceiverLink.prototype, '_messageReceived', createWrapMessageReceived(tracer, config))
    },
    unpatch (ReceiverLink) {
      this.unwrap(ReceiverLink.prototype, '_messageReceived')
    }
  }
]
