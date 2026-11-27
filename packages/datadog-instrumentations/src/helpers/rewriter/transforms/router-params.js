'use strict'

const assert = require('node:assert/strict')

const { parse, query } = require('../compiler')

module.exports = { publishRouterParams }

/**
 * @param {{ channelName: string, transforms: { tracingChannelDeclaration: Function } }} state
 * @param {import('estree').ReturnStatement | import('estree').ExpressionStatement} node
 * @param {import('estree').BlockStatement} parent
 * @param {import('estree').Node[]} ancestry
 */
function publishRouterParams (state, node, parent, ancestry) {
  const call = /** @type {import('estree').CallExpression} */ (
    node.type === 'ReturnStatement' ? node.argument : node.expression
  )
  const continuation = /** @type {import('estree').FunctionExpression} */ (call.arguments.at(-1))
  const error = /** @type {import('estree').Identifier} */ (continuation.params[0])

  const nextIndex = ancestry.findIndex(ancestor => ancestor.type === 'FunctionDeclaration' &&
    ancestor.id?.name === 'next')
  const next = /** @type {import('estree').FunctionDeclaration} */ (ancestry[nextIndex])
  const handle = /** @type {import('estree').BlockStatement} */ (ancestry[nextIndex + 1])

  const methodMatches = query(parent, 'VariableDeclarator[init.callee.object.name="route"]' +
    '[init.callee.property.name=/^_handles(Method|_method)$/]')
  assert.strictEqual(methodMatches.length, 1)
  const methodMatch = /** @type {import('estree').VariableDeclarator} */ (methodMatches[0])

  const nativeKeys = call.callee.type === 'Identifier' && call.arguments.length === 7 ? call.arguments[2] : undefined
  const nativeMatch = nativeKeys?.type === 'MemberExpression' && nativeKeys.object.type === 'Identifier' &&
    nativeKeys.property.type === 'Identifier' && nativeKeys.property.name === 'keys'
    ? nativeKeys.object.name
    : undefined

  state.transforms.tracingChannelDeclaration(state, ancestry.at(-1))
  const channel = `tr_ch_apm$${state.channelName.replaceAll(/[^\w]/g, '_')}`
  const [activeBinding, matchBinding, matchAssignment, ...start] = parse(`
    let __apm$activeRouteParams
    let __apm$methodMatched
    __apm$methodMatched = undefined
    let __apm$routeParams
    if (route && __apm$methodMatched && ${channel}.start.hasSubscribers &&
        ${nativeMatch ?? 'layer'}.keys?.length) {
      __apm$routeParams = {
        req,
        layer,
        pattern: ${nativeMatch ? `${nativeMatch}.pattern` : 'undefined'},
        path: undefined,
        active: true,
      }
      __apm$activeRouteParams = __apm$routeParams
      ${channel}.start.publish(__apm$routeParams)
    }
  `).body
  const assignment = /** @type {import('estree').AssignmentExpression} */ (
    (/** @type {import('estree').ExpressionStatement} */ (matchAssignment)).expression
  )
  assignment.right = methodMatch.init
  methodMatch.init = assignment
  parent.body.splice(parent.body.indexOf(node), 0, ...start)
  parent.body.unshift(matchBinding)

  handle.body.unshift(activeBinding)
  next.body.body.unshift(...parse(`
    if (__apm$activeRouteParams) {
      __apm$activeRouteParams.active = false
      __apm$activeRouteParams = undefined
    }
  `).body)
  continuation.body.body.unshift(...parse(`
    if (__apm$routeParams) {
      __apm$routeParams.active = false
      if (__apm$activeRouteParams === __apm$routeParams) {
        __apm$activeRouteParams = undefined
      }
      if (!${error.name} && __apm$routeParams.path !== undefined) {
        ${channel}.end.publish(__apm$routeParams)
      }
      __apm$routeParams = undefined
    }
  `).body)
}
