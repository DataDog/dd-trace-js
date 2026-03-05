'use strict'

const { createIntegration } = require('..')
const log = require('../../../dd-trace/src/log')

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
  pu: 'presence-unsubscribe',
}

function getActionName (request) {
  const action = request?.a
  return READABLE_ACTION_NAMES[action] || action
}

function getReadableResourceName (actionName, collection, query) {
  let resource = actionName || ''
  if (collection) {
    resource += ' ' + collection
  }
  if (query) {
    try {
      resource += ' ' + JSON.stringify(sanitize(query))
    } catch (err) {
      log.warn('sharedb: failed to serialize query: %s', err.message)
      resource += ' ?'
    }
  }
  return resource
}

function sanitize (input, depth = 0) {
  if (depth > 20 || !isObject(input) || Buffer.isBuffer(input)) return '?'

  const output = {}
  for (const key of Object.keys(input)) {
    if (typeof input[key] === 'function') continue
    output[key] = sanitize(input[key], depth + 1)
  }
  return output
}

function isObject (val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val)
}

module.exports = createIntegration({
  id: 'sharedb',
  module: 'sharedb',
  versions: '>=1',
  file: 'lib/agent.js',
  type: 'server',
  intercepts: [{
    astQuery: 'AssignmentExpression[left.property.name="_handleMessage"] > FunctionExpression',
    channelName: 'Agent__handleMessage',
    kind: 'Callback',
    index: 1,
    span: {
      name: 'sharedb.request',
      spanKind: 'server',
      resource (ctx) {
        const request = ctx.arguments?.[0]
        const actionName = getActionName(request)
        return getReadableResourceName(actionName, request?.c, request?.q)
      },
      attributes (ctx) {
        const request = ctx.arguments?.[0]
        return {
          'sharedb.action': getActionName(request),
        }
      },
      onStart (ctx, span) {
        if (ctx.config.hooks?.receive) {
          ctx.config.hooks.receive(span, ctx.arguments?.[0])
        }
      },
      onFinish (ctx, span) {
        if (ctx.config.hooks?.reply) {
          ctx.config.hooks.reply(span, ctx.arguments?.[0], ctx.result)
        }
      },
    },
  }],
})
