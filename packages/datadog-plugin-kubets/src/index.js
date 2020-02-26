'use strict'

const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

function addTagsForRequest (tracer, config, span, request) {
  const body = request.getBody();

  span.addTags({
    'service.name': config.service || `${tracer._service}-kubets`,
    channel: request.getChannel() || 'No channel specified',
    body: (typeof body === 'string' ? body : body.toString()) || 'No body specified',
    metadata: request.getMetadata() || 'No metadata specified'
  });
  span.setTag('type.query') // TODO: Differentiate between query and events
}

function createWrapSendRequest (tracer, config) {
  return function wrapSendRequest (sendFunction) { // This runs BEFORE the function
    const isValid = (that, request) => {
      return true;
    };

    return function sendRequestWithTrace (request) { // This is the Request kubets class, this is where it gets ran
      if (!isValid(this, arguments)) return sendFunction.apply(this, arguments); // TODO: Prevents errors stopping execution.
      const span = tracer.startSpan('kubets.request', {
        tags: {
          'component': 'kubets'
        }
      }) // TODO: Look into childOf (idk if that's needed as its req-res)

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
