'use strict'

// TODO: add ctx.params when nested object properties are deprecated

function moleculerTags (broker, ctx, config) {
  const service = ctx.service || {}
  const action = ctx.action || {}
  const meta = config.meta && ctx.meta

  return {
    'moleculer.context.action': action.name,
    'moleculer.context.meta': meta,
    'moleculer.context.node_id': ctx.nodeID,
    'moleculer.context.request_id': ctx.requestID,
    'moleculer.context.service': service.name,
    'moleculer.namespace': broker.namespace,
    'moleculer.node_id': broker.nodeID
  }
}

module.exports = { moleculerTags }
