'use strict'

const { parse, query } = require('../compiler')

module.exports = { publishKoaCallback, publishKoaRouterDispatch }

/**
 * @param {{ channelName: string, transforms: { tracingChannelDeclaration: Function } }} state
 * @param {import('estree').ReturnStatement} node
 * @param {import('estree').BlockStatement} parent
 * @param {import('estree').Node[]} ancestry
 */
function publishKoaCallback (state, node, parent, ancestry) {
  const [composition] = /** @type {import('estree').VariableDeclaration[]} */ (query(parent,
    'BlockStatement > VariableDeclaration[kind=const][declarations.0.id.name=fn]'
  ))
  const index = parent.body.indexOf(composition)

  state.transforms.tracingChannelDeclaration(state, ancestry.at(-1))
  const channelVariable = `tr_ch_apm$${state.channelName.replaceAll(/[^\w]/g, '_')}`
  const [composer, stack, apply, publish] = parse(`
    const __apm$koaCompose = undefined
    const __apm$koaStack = undefined
    Reflect.apply(__apm$koaCompose, this, [__apm$koaStack])
    if (__apm$koaCompose === compose && ${channelVariable}.end.hasSubscribers) {
      ${channelVariable}.end.publish({ handleRequest, stack: __apm$koaStack })
    }
  `).body
  const declaration = composition.declarations[0]
  const call = /** @type {import('estree').CallExpression} */ (declaration.init)
  const composerDeclaration = /** @type {import('estree').VariableDeclaration} */ (composer)
  const stackDeclaration = /** @type {import('estree').VariableDeclaration} */ (stack)
  composerDeclaration.declarations[0].init = call.callee
  stackDeclaration.declarations[0].init = /** @type {import('estree').Expression} */ (call.arguments[0])
  declaration.init = /** @type {import('estree').ExpressionStatement} */ (apply).expression

  parent.body.splice(index, 0, composer, stack)
  parent.body.splice(parent.body.indexOf(node), 0, publish)
}

/**
 * @param {{ channelName: string, transforms: { tracingChannelDeclaration: Function } }} state
 * @param {import('estree').ReturnStatement} node
 * @param {import('estree').BlockStatement} parent
 * @param {import('estree').Node[]} ancestry
 */
function publishKoaRouterDispatch (state, node, parent, ancestry) {
  const dispatch = /** @type {import('estree').CallExpression} */ (node.argument)
  const compose = /** @type {import('estree').CallExpression} */ (dispatch.callee)
  const context = /** @type {import('estree').Identifier} */ (dispatch.arguments[0])
  const chain = /** @type {import('estree').Identifier} */ (compose.arguments[0])

  state.transforms.tracingChannelDeclaration(state, ancestry.at(-1))
  const channelVariable = `tr_ch_apm$${state.channelName.replaceAll(/[^\w]/g, '_')}`
  const statements = parse(`
    const __apm$koaDispatch = undefined
    if (${channelVariable}.start.hasSubscribers) {
      ${channelVariable}.start.publish({ context: ${context.name}, chain: ${chain.name} })
    }
  `).body
  const binding = /** @type {import('estree').VariableDeclaration} */ (statements[0])
  binding.declarations[0].init = compose
  dispatch.callee = /** @type {import('estree').Identifier} */ (binding.declarations[0].id)
  parent.body.splice(parent.body.indexOf(node), 0, ...statements)
}
