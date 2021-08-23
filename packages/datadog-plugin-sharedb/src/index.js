'use strict'

/**
 * @description The enum values in this map are not exposed from ShareDB, so the keys are hard-coded here.
 * The values were derived from: https://github.com/share/sharedb/blob/master/lib/client/connection.js#L196
 */
const READABLE_ACTION_NAMES = {
  hs: 'handshake',
  qf: 'query-fetch',
  qs: 'query-subscribe',
  qu: 'query-unsubscribe',
  bf: 'bulk-fetch',
  bs: 'bulk-subscribe',
  bu: 'bulk-unsubscribe',
  f: 'fetch',
  s: 'subscribe',
  u: 'unsubscribe',
  op: 'op',
  nf: 'snapshot-fetch',
  nt: 'snapshot-fetch-by-ts',
  p: 'presence-broadcast',
  pr: 'presence-request',
  ps: 'presence-subscribe',
  pu: 'presence-unsubscribe'
}

function getReadableActionName (action) {
  const actionName = READABLE_ACTION_NAMES[action]
  if (actionName === undefined) {
    return action
  }
  return actionName
}

function getReadableResourceName (readableActionName, collection, query) {
  if (collection) {
    readableActionName += ' ' + collection
  }
  if (query) {
    readableActionName += ' ' + JSON.stringify(sanitize(query))
  }
  return readableActionName
}

function sanitize (input) {
  const output = {}

  if (!isObject(input) || Buffer.isBuffer(input)) return '?'

  for (const key in input) {
    if (typeof input[key] === 'function') continue

    output[key] = sanitize(input[key])
  }

  return output
}

function isObject (val) {
  return typeof val === 'object' && val !== null && !(val instanceof Array)
}

function wrapCallback (config, tracer, request, span, done) {
  return tracer.scope().bind((err, res) => {
    if (err) {
      span.setTag('error', err)
    }

    if (config.hooks && config.hooks.reply) {
      config.hooks.reply(span, request, res)
    }

    span.finish()

    if (done) {
      done(err, res)
    }
  })
}

function createAgentWrapHandle (tracer, config) {
  return function wrapHandleMessage (origHandleMessageFn) { // called once
    return function handleMessageWithTrace (request, callback) { // called for each trigger
      const action = request.a

      const actionName = getReadableActionName(action)

      const scope = tracer.scope()
      const childOf = scope.active()
      const span = tracer.startSpan('sharedb.request', {
        childOf,
        tags: {
          'service.name': config.service || tracer._service,
          'span.kind': 'server',
          'sharedb.action': actionName,
          'resource.name': getReadableResourceName(actionName, request.c, request.q)
        }
      })

      if (config.hooks && config.hooks.receive) {
        config.hooks.receive(span, request)
      }

      const wrappedCallback = wrapCallback(config, tracer, request, span, callback)

      return tracer.scope().bind(origHandleMessageFn, span).call(this, request, wrappedCallback)
    }
  }
}

module.exports = {
  name: 'sharedb',
  versions: ['>=1'],
  file: 'lib/agent.js',
  patch (Agent, tracer, config) {
    this.wrap(Agent.prototype, '_handleMessage', createAgentWrapHandle(tracer, config))
  },
  unpatch (Agent) {
    this.unwrap(Agent.prototype, '_handleMessage')
  }
}
