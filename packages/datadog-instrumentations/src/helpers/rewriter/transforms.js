'use strict'

const { parse, query, traverse } = require('./compiler')

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

  traceAsyncGenerator: traceAny,
  traceCallback: traceAny,
  traceGenerator: traceAny,
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

  // The original function cannot be a generator function because their bodies
  // don't execute before the first call to `next()` and we want to publish
  // before that. So instead we make it a normal function and will return the
  // generator from the wrapped function.
  node.generator = false

  node.body = wrap(state, {
    type: 'FunctionExpression',
    params: node.params,
    body: node.body,
    async: operator === 'tracePromise',
    expression: false,
    generator: operator === 'traceGenerator',
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
  const { channelName, operator } = state

  wrapSuper(state, node)

  if (operator === 'traceAsyncGenerator') return wrapGenerator(state, node)
  if (operator === 'traceCallback') return wrapCallback(state, node)
  if (operator === 'traceGenerator') return wrapGenerator(state, node)

  const async = operator === 'tracePromise' ? 'async' : ''
  const channelVariable = 'tr_ch_apm$' + channelName.replaceAll(':', '_')
  const wrapper = parse(`
    function wrapper () {
      const __apm$traced = ${async} () => {
        const __apm$wrapped = () => {};
        return __apm$wrapped.apply(this, arguments);
      };
      if (!${channelVariable}.hasSubscribers) return __apm$traced();
      return ${channelVariable}.${operator}(__apm$traced, {
        arguments,
        self: this,
        moduleVersion: "1.0.0"
      });
    }
  `).body[0].body // Extract only block statement of function body.

  // Replace the right-hand side assignment of `const __apm$wrapped = () => {}`.
  query(wrapper, '[id.name=__apm$wrapped]')[0].init = node

  return wrapper
}

function wrapSuper (state, node) {
  traverse(
    node.body,
    '[object.type=Super]',
    (node, parent) => {
      const method = node.property.name
      const { callee } = parent

      if (callee) {
        const expression = parse(`
          Reflect.get(Object.getPrototypeOf(this.constructor.prototype), '${method}').call(this)
        `).body[0].expression

        parent.callee = expression.callee
        parent.arguments.unshift(...expression.arguments)
      } else {
        parent.expression = parse(`
          Reflect.get(Object.getPrototypeOf(this.constructor.prototype), '${method}')
        `).body[0]
      }
    }
  )
}

function wrapCallback (state, node) {
  const { channelName, functionQuery: { index = -1 } } = state
  const channelVariable = 'tr_ch_apm$' + channelName.replaceAll(':', '_')
  const wrapper = parse(`
    function wrapper () {
      const __apm$cb = Array.prototype.at.call(arguments, ${index});
      const __apm$ctx = {
        arguments,
        self: this,
        moduleVersion: "1.0.0"
      };
      const __apm$traced = () => {
        const __apm$wrapped = () => {};
        return __apm$wrapped.apply(this, arguments);
      };

      if (!${channelVariable}.start.hasSubscribers) return __apm$traced();

      function __apm$wrappedCb(err, res) {
        if (err) {
          __apm$ctx.error = err;
          ${channelVariable}.error.publish(__apm$ctx);
        } else {
          __apm$ctx.result = res;
        }

        ${channelVariable}.asyncStart.runStores(__apm$ctx, () => {
          try {
            if (__apm$cb) {
              return __apm$cb.apply(this, arguments);
            }
          } finally {
            ${channelVariable}.asyncEnd.publish(__apm$ctx);
          }
        });
      }

      if (typeof __apm$cb !== 'function') {
        return __apm$traced();
      }
      Array.prototype.splice.call(arguments, ${index}, 1, __apm$wrappedCb);

      return ${channelVariable}.start.runStores(__apm$ctx, () => {
        try {
          return __apm$traced();
        } catch (err) {
          __apm$ctx.error = err;
          ${channelVariable}.error.publish(__apm$ctx);
          throw err;
        } finally {
          ${channelVariable}.end.publish(__apm$ctx);
        }
      });
    }
  `).body[0].body // Extract only block statement of function body.

  // Replace the right-hand side assignment of `const __apm$wrapped = () => {}`.
  query(wrapper, '[id.name=__apm$wrapped]')[0].init = node

  return wrapper
}

function wrapGenerator (state, node) {
  const { channelName, operator } = state
  const channelVariable = 'tr_ch_apm$' + channelName.replaceAll(':', '_')
  const nextChannel = channelVariable + '_next'
  const traceMethod = operator === 'traceAsyncGenerator' ? 'tracePromise' : 'traceSync'
  const traceNext = `${nextChannel}.${traceMethod}`
  const wrapper = parse(`
    function wrapper () {
      const __apm$traced = () => {
        const __apm$wrapped = () => {};
        return __apm$wrapped.apply(this, arguments);
      };

      if (!${channelVariable}.start.hasSubscribers) return __apm$traced();

      {
        const ctx = {
          arguments,
          self: this,
          moduleVersion: "1.0.0"
        };
        const gen = ${channelVariable}.traceSync(__apm$traced, ctx);
        const { next: genNext, return: genReturn, throw: genThrow } = gen;

        gen.next = (...args) => ${traceNext}(genNext, ctx, gen, ...args);
        gen.return = (...args) => ${traceNext}(genReturn, ctx, gen, ...args);
        gen.throw = (...args) => ${traceNext}(genThrow, ctx, gen, ...args);

        return gen;
      };
    }
  `).body[0].body // Extract only block statement of function body.

  // Replace the right-hand side assignment of `const __apm$wrapped = () => {}`.
  query(wrapper, '[id.name=__apm$wrapped]')[0].init = node

  return wrapper
}
