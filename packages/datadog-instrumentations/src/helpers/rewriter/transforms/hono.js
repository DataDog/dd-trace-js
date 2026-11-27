'use strict'

const { parse, query } = require('../compiler')

module.exports = { publishHonoMiddlewareRoute }

/**
 * @param {{ channelName: string, transforms: { tracingChannelDeclaration: Function } }} state
 * @param {import('estree').MethodDefinition} method
 * @param {import('estree').ClassBody} parent
 * @param {import('estree').Node[]} ancestry
 */
function publishHonoMiddlewareRoute (state, method, parent, ancestry) {
  const addRoute = 'CallExpression[callee.property.name="addRoute"]'
  const [use] = query(parent, 'AssignmentExpression[left.object.type="ThisExpression"]' +
    `[left.property.name="use"] ${addRoute}`)
  const [copy] = query(parent, `MethodDefinition[key.name="route"] ${addRoute}`)
  const body = method.value.body.body
  const [registration] = query(method.value.body, 'ExpressionStatement' +
    '[expression.callee.object.property.name="router"][expression.callee.property.name="add"]')
  const record = registration?.expression.arguments[2]?.elements?.[1]
  const source = copy?.arguments[0]?.object
  const params = method.value.params
  if (!use || !copy || !body.includes(registration) || record?.type !== 'Identifier' || source?.type !== 'Identifier' ||
      use.arguments.length > params.length || copy.arguments.length > params.length) {
    return
  }

  for (const call of [use, copy]) {
    while (call.arguments.length < params.length) {
      call.arguments.push({ type: 'Identifier', name: 'undefined' })
    }
  }
  use.arguments.push({ type: 'Literal', value: true })
  copy.arguments.push(source)
  params.push({
    type: 'AssignmentPattern',
    left: { type: 'Identifier', name: '__apm$sourceRoute' },
    right: { type: 'Identifier', name: 'undefined' },
  })

  state.transforms.tracingChannelDeclaration(state, ancestry.at(-1))
  const channel = `tr_ch_apm$${state.channelName.replaceAll(/[^\w]/g, '_')}`
  body.splice(body.indexOf(registration), 0, ...parse(`
    if (__apm$sourceRoute !== undefined && ${channel}.start.hasSubscribers) {
      ${channel}.start.publish({ record: ${record.name}, source: __apm$sourceRoute })
    }
  `).body)
}
