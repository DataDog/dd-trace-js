'use strict'

function createWrapSendProduceRequest (tracer, config) {
  return function wrapSendProduceRequest (sendProduceRequest) {
    return function sendProduceRequestWithTrace (payloads, requireAcks, ackTimeoutMs, callback) {
      console.log(payloads)

      const span = startSpan(tracer, config, 'kafka.send')

      span.addTags({
        'span.kind': 'producer'
        // 'resource.name': options.command,
      })

      return sendProduceRequest.call(this, payloads, requireAcks, ackTimeoutMs, wrapCallback(callback, span))
    }
  }
}

function startSpan (tracer, config, name) {
  const scope = tracer.scopeManager().active()
  const span = tracer.startSpan(name, {
    childOf: scope && scope.span(),
    tags: {
      'span.type': 'kafka',
      'service.name': config.service || `${tracer._service}-kafka`
    }
  })

  return span
}

function wrapCallback (callback, span) {
  return function (err) {
    addError(span, err)

    span.finish()

    return callback.apply(this, arguments)
  }
}

function addError (span, error) {
  if (error) {
    span.addTags({
      'error.type': error.name,
      'error.msg': error.message,
      'error.stack': error.stack
    })
  }

  return error
}

module.exports = {
  name: 'kafka-node',
  versions: ['2.x'],
  patch (kafka, tracer, config) {
    this.wrap(kafka.KafkaClient.prototype, 'sendProduceRequest', createWrapSendProduceRequest(tracer, config))
  },
  unpatch (kafka) {
    this.unwrap(kafka.KafkaClient.prototype, 'sendProduceRequest')
  }
}
