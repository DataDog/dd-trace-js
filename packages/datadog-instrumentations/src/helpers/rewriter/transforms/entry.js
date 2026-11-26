'use strict'

const { parse } = require('../compiler')

const functionTypes = new Set(['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'])

module.exports = { publishEntry }

/**
 * Publishes on the `orchestrion:<module>:<channelName>` channel each time the matched function is entered. Unlike
 * the tracing transforms, the function is not wrapped. A generator publishes on its first `next()`.
 * Returns whether the function now publishes on entry.
 *
 * @param {{ channelName: string, module: { name: string }, transforms: Record<string, Function> }} state
 * @param {import('estree').Node} node
 * @param {import('estree').Node} _parent
 * @param {import('estree').Node[]} ancestry
 */
function publishEntry (state, node, _parent, ancestry) {
  // Class selectors also match the class itself; only its methods are instrumented.
  if (!functionTypes.has(node.type)) return false

  const channelVariable = `tr_ch_apm_entry$${state.channelName.replaceAll(/\W/g, '_')}`
  declareChannel(state, ancestry.at(-1), channelVariable)

  if (node.body.type !== 'BlockStatement') {
    node.body = { type: 'BlockStatement', body: [{ type: 'ReturnStatement', argument: node.body }] }
    node.expression = false
  }

  const statements = node.body.body
  // Statements must not precede the directive prologue, or `'use strict'` stops applying.
  let index = 0
  while (typeof statements[index]?.directive === 'string') index++

  if (!publishesTo(statements[index], channelVariable)) {
    statements.splice(index, 0, parse(`if (${channelVariable}.hasSubscribers) ${channelVariable}.publish()`).body[0])
  }

  return true
}

/**
 * @param {{ channelName: string, module: { name: string }, transforms: Record<string, Function> }} state
 * @param {import('estree').Program} program
 * @param {string} channelVariable
 */
function declareChannel (state, program, channelVariable) {
  if (program.body.some(child => child.declarations?.[0]?.id?.name === channelVariable)) return

  // Reuses the transformer's diagnostics channel import, shared with any tracing transform of the file.
  state.transforms.tracingChannelImport(state, program)

  const index = program.body.findIndex(child =>
    child.declarations?.[0]?.id?.properties?.[0]?.value?.name === 'tr_ch_apm_tracingChannel'
  )
  const channelName = JSON.stringify(`orchestrion:${state.module.name}:${state.channelName}`)

  program.body.splice(index + 1, 0, parse(`const ${channelVariable} = tr_ch_apm_dc.channel(${channelName})`).body[0])
}

/**
 * @param {import('estree').Node|undefined} statement
 * @param {string} channelVariable
 */
function publishesTo (statement, channelVariable) {
  return statement?.type === 'IfStatement' && statement.test.type === 'MemberExpression' &&
    statement.test.object.name === channelVariable
}
