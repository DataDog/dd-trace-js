'use strict'

const { parse } = require('./compiler')

const tracingChannelPredicate = (node) => (
  node.specifiers?.[0]?.local?.name === 'tr_ch_apm_tracingChannel' ||
    node.declarations?.[0]?.id?.properties?.[0]?.value?.name === 'tr_ch_apm_tracingChannel'
)

const transforms = module.exports = {
  tracingChannelImport ({ format }, node) {
    if (node.body.some(tracingChannelPredicate)) return

    const index = node.body.findIndex(child => child.directive === 'use strict')
    const code = format === 'module'
      ? 'import { tracingChannel as tr_ch_apm_tracingChannel } from "diagnostics_channel"'
      : 'const {tracingChannel: tr_ch_apm_tracingChannel} = require("diagnostics_channel")'

    node.body.splice(index + 1, 0, parse(code, { module: format === 'module' }).body[0])
  },

  tracingChannelDeclaration (state, node) {
    const { channelName, module: { name } } = state
    const channelVariable = 'tr_ch_apm$' + channelName.replaceAll(':', '_')

    if (node.body.some(child => child.declarations?.[0]?.id?.name === channelVariable)) return

    transforms.tracingChannelImport(state, node)

    const index = node.body.findIndex(tracingChannelPredicate)
    const code = `
      const ${channelVariable} = tr_ch_apm_tracingChannel("orchestrion:${name}:${channelName}")
    `

    node.body.splice(index + 1, 0, parse(code).body[0])
  },

  traceCallback: traceAny,
  tracePromise: traceAny,
  traceSync: traceAny,
}

function traceAny (state, node, _parent, ancestry) {
  const program = ancestry[ancestry.length - 1]

  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    traceInstanceMethod(state, node, program)
  } else {
    traceFunction(state, node, program)
  }
}

function traceFunction (state, node, program) {
  const { operator } = state

  transforms.tracingChannelDeclaration(state, program)

  node.body = wrap(state, {
    type: 'ArrowFunctionExpression',
    params: node.params,
    body: node.body,
    async: operator === 'tracePromise',
    expression: false,
    generator: false
  })
}

function traceInstanceMethod (state, node, program) {
  const { functionQuery, operator } = state
  const { methodName } = functionQuery

  const classBody = node.body

  // If the method exists on the class, we return as it will be patched later
  // while traversing child nodes later on.
  if (classBody.body.some(({ key }) => key.name === methodName)) return

  // Method doesn't exist on the class so we assume an instance method and
  // wrap it in the constructor instead.
  let ctor = classBody.body.find(({ kind }) => kind === 'constructor')

  transforms.tracingChannelDeclaration(state, program)

  if (!ctor) {
    ctor = parse(
      node.superClass
        ? 'class A { constructor (...args) { super(...args) } }'
        : 'class A { constructor () {} }'
    ).body[0].body.body[0] // Extract constructor from dummy class body.

    classBody.body.unshift(ctor)
  }

  const ctorBody = parse(`
    const __apm$${methodName} = this["${methodName}"]
    this["${methodName}"] = function () {}
  `).body

  // Extract only right-hand side function of line 2.
  const fn = ctorBody[1].expression.right

  fn.async = operator === 'tracePromise'
  fn.body = wrap(state, { type: 'Identifier', name: `__apm$${methodName}` })

  ctor.value.body.body.push(...ctorBody)
}

function wrap (state, node) {
  const { channelName, operator, functionQuery: { index = -1 } } = state
  const async = operator === 'tracePromise' ? 'async' : ''
  const channelVariable = 'tr_ch_apm$' + channelName.replaceAll(':', '_')
  const tracedArgs = operator === 'traceCallback'
    ? `__apm$original_args.splice(${index}, 1, arguments[${index >= 0 ? index : `arguments.length + ${index}`}])`
    : '__apm$original_args'
  const traceParams = operator === 'traceCallback'
    ? `__apm$traced, ${index}`
    : '__apm$traced'
  const wrapper = parse(`
    function wrapper () {
      const __apm$original_args = arguments;
      const __apm$traced = ${async} function () {
        const __apm$wrapped = () => {};
        const __apm$traced_args = ${tracedArgs};
        return __apm$wrapped.apply(this, __apm$traced_args);
      };
      if (!${channelVariable}.hasSubscribers) return __apm$traced.apply(this, arguments);
      return ${channelVariable}.${operator}(${traceParams}, {
        arguments,
        self: this,
        moduleVersion: "1.0.0"
      }, this, ...arguments);
    }
  `).body[0].body // Extract only block statement of function body.

  // Replace the right-hand side assignment of `const __apm$wrapped = () => {}`.
  wrapper.body[1].declarations[0].init.body.body[0].declarations[0].init = node

  return wrapper
}
