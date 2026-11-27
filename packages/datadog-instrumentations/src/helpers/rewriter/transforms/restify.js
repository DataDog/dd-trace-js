'use strict'

const { parse } = require('../compiler')

module.exports = { publishRestifyRoute }

/**
 * @param {{ channelName: string, transforms: { tracingChannelDeclaration: Function } }} state
 * @param {import('estree').ExpressionStatement} node
 * @param {import('estree').BlockStatement} parent
 * @param {import('estree').Node[]} ancestry
 */
function publishRestifyRoute (state, node, parent, ancestry) {
  const emit = /** @type {import('estree').CallExpression} */ (node.expression)
  const req = /** @type {import('estree').Identifier} */ (emit.arguments[1])
  const emittedRoute = emit.arguments[3]
  const route = emittedRoute.type === 'Identifier' ? `${emittedRoute.name}.spec` : `${req.name}.route`

  state.transforms.tracingChannelDeclaration(state, ancestry.at(-1))
  const channel = `tr_ch_apm$${state.channelName.replaceAll(/[^\w]/g, '_')}`
  parent.body.splice(parent.body.indexOf(node), 0, ...parse(`
    if (${channel}.start.hasSubscribers) {
      ${channel}.start.publish({ req: ${req.name}, path: ${route}?.path })
    }
  `).body)
}
