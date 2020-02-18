'use strict'

const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

function addTagsForRequest (tracer, config, span, request) {
  span.addTags({
    'service.name': config.service || `${tracer._service}-kubets`,
    channel: request.getChannel(),
    body: request.getBody(),
    metadata: request.getMetadata()
  })
  span.setTag('type.query') // TODO: Differentiate between query and events
}

function createWrapSendRequest (tracer, config) {
  return function wrapSendRequest (sendFunction) { // This runs BEFORE the function
    return function sendRequestWithTrace (request) { // This is the Request kubets class, this is where it gets ran
      const span = tracer.startSpan('kubets.request')
      addTagsForRequest(tracer, config, span, request)

      analyticsSampler.sample(span, config.analytics, true)

      tracer.scope().activate(span, () => {
        try {
          sendFunction.apply(this, arguments)
        } catch (e) {
          throw addError(span, e)
        } finally {
          span.finish()
        }
      })
    }
  }
}

function addError (span, error) {
  span.addTags({
    'error.type': error.name,
    'error.msg': error.message,
    'error.stack': error.stack
  })

  return error
}
module.exports = [
  {
    name: 'kubets',
    versions: ['>=0.2'],
    patch ({ GeneralSender, GeneralReceiver }, tracer, config) {
      this.wrap(GeneralSender.prototype, 'send', createWrapSendRequest(tracer, config))
    },
    unpatch ({ GeneralSender, GeneralReceiver }) {
      this.unwrap(GeneralSender.prototype, 'send')
    }
  }
]
