'use strict'

// TODO: Move traceIterator to Orchestrion.

const { parse, query, traverse } = require('./compiler')

/** @param {object} node Program body statement */
function hasOrchestrionDcPolyfill (node) {
  if (node.type === 'ImportDeclaration') {
    const local = node.specifiers?.[0]?.local?.name
    return local === 'tr_ch_apm_tracingChannel' || local === 'tr_ch_apm_dc'
  }
  if (node.type !== 'VariableDeclaration') return false
  const decl = node.declarations?.[0]
  if (!decl) return false
  // Two-step CJS: const tr_ch_apm_dc = require(…)
  if (decl.init?.name === 'tr_ch_apm_dc') return true
  // Single-step CJS: const {tracingChannel: tr_ch_apm_tracingChannel} = require(…)
  const prop = decl.id?.properties?.[0]
  return prop?.value?.name === 'tr_ch_apm_tracingChannel'
}

/** Index of the statement after which orchestrion channel consts should be inserted. */
function tracingChannelBindingStatementIndex (node) {
  return hasOrchestrionDcPolyfill(node)
}

const transforms = module.exports = {
  tracingChannelImport ({ dcModule, sourceType, moduleType }, node) {
    if (node.body.some(hasOrchestrionDcPolyfill)) return

    // `@apm-js-collab/code-transformer` passes `moduleType` ('esm' | 'cjs'); older paths used `sourceType`.
    const moduleKind = sourceType ?? moduleType

    const index = node.body.findIndex(child => child.directive === 'use strict')
    const isModule = isModuleSourceType(moduleKind)
    if (isModule) {
      // `dcModule` is usually `…/dc-polyfill.js` (CJS). Named ESM import fails; default-import then destructure.
      const defaultImport = parse(`import tr_ch_apm_dc from "${dcModule}"`, { isModule: true }).body[0]
      const destructure = parse(
        'const { tracingChannel: tr_ch_apm_tracingChannel } = tr_ch_apm_dc',
        { isModule: true }
      ).body[0]
      node.body.splice(index + 1, 0, defaultImport, destructure)
    } else {
      const code = `const {tracingChannel: tr_ch_apm_tracingChannel} = require("${dcModule}")`
      node.body.splice(index + 1, 0, parse(code, { isModule: false }).body[0])
    }
  },

  tracingChannelDeclaration (state, node) {
    const { channelName, module: { name } } = state
    const channelVariable = 'tr_ch_apm$' + channelName.replaceAll(':', '_')

    if (node.body.some(child => child.declarations?.[0]?.id?.name === channelVariable)) return

    transforms.tracingChannelImport(state, node)

    const index = node.body.findIndex(tracingChannelBindingStatementIndex)
    const code = `
      const ${channelVariable} = tr_ch_apm_tracingChannel("orchestrion:${name}:${channelName}")
    `

    node.body.splice(index + 1, 0, parse(code).body[0])
  },

  traceAsyncIterator: traceAny,
  traceIterator: traceAny,
}

function traceAny (state, node, _parent, ancestry) {
  const program = ancestry[ancestry.length - 1]

  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    traceInstanceMethod(state, node, program)
  } else {
    traceFunction(state, node, program)
  }
}

/**
 * @param {string} [moduleKind] `sourceType` or `moduleType` from the transformer (`'module'`, `'esm'`, `'cjs'`).
 */
function isModuleSourceType (moduleKind) {
  return moduleKind === 'module' || moduleKind === 'esm'
}

function traceFunction (state, node, program) {
  transforms.tracingChannelDeclaration(state, program)

  node.body = wrap(state, {
    type: 'FunctionExpression',
    params: node.params,
    body: node.body,
    async: node.async,
    expression: false,
    generator: node.generator,
  }, program)

  // The original function no longer contains any calls to `await` or `yield` as
  // the function body is copied to the internal wrapped function, so we set
  // these to false to avoid altering the return value of the wrapper. The old
  // values are instead copied to the new AST node above.
  node.generator = false
  node.async = false

  wrapSuper(state, node)
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
  fn.body = wrap(state, { type: 'Identifier', name: `__apm$${methodName}` }, program)

  wrapSuper(state, fn)

  ctor.value.body.body.push(...ctorBody)
}

function wrap (state, node, program) {
  const { operator } = state

  if (operator === 'traceAsyncIterator') return wrapIterator(state, node, program)
  if (operator === 'traceIterator') return wrapIterator(state, node, program)
}

function wrapSuper (_state, node) {
  const members = new Set()

  traverse(
    node.body,
    '[object.type=Super]',
    (node, parent) => {
      const { name } = node.property

      let child

      if (parent.callee) {
        // This is needed because for generator functions we have to move the
        // original function to a nested wrapped function, but we can't use an
        // arrow function because arrow function cannot be generator functions,
        // and `super` cannot be called from a nested function, so we have to
        // rewrite any `super` call to not use the keyword.
        const { expression } = parse(`__apm$super['${name}'].call(this)`).body[0]

        parent.callee = child = expression.callee
        parent.arguments.unshift(...expression.arguments)
      } else {
        parent.expression = child = parse(`__apm$super['${name}']`).body[0]
      }

      child.computed = parent.callee.computed
      child.optional = parent.callee.optional

      members.add(name)
    }
  )

  for (const name of members) {
    const member = parse(`
      class Wrapper {
        wrapper () {
          __apm$super['${name}'] = super['${name}']
        }
      }
    `).body[0].body.body[0].value.body.body[0]

    node.body.body.unshift(member)
  }

  if (members.size > 0) {
    node.body.body.unshift(parse('const __apm$super = {}').body[0])
  }
}

function wrapIterator (state, node, program) {
  const { channelName, operator } = state
  const baseChannel = channelName.replaceAll(':', '_')
  const channelVariable = 'tr_ch_apm$' + baseChannel
  const nextChannel = baseChannel + '_next'
  const traceMethod = operator === 'traceAsyncIterator' ? 'tracePromise' : 'traceSync'
  const traceNext = `tr_ch_apm$${nextChannel}.${traceMethod}`

  transforms.tracingChannelDeclaration({ ...state, channelName: nextChannel }, program)

  const wrapper = parse(`
    function wrapper () {
      const __apm$traced = () => {
        const __apm$wrapped = () => {};
        return __apm$wrapped.apply(this, arguments);
      };

      if (!${channelVariable}.start.hasSubscribers) return __apm$traced();

      {
        const wrap = iter => {
          if (iter != null && typeof iter === 'object') {
            const apmIterWrappedSym = Symbol.for('dd.apm.wrappedAsyncIter');
            if (iter[apmIterWrappedSym]) return iter;
            iter[apmIterWrappedSym] = true;
          }

          const { next: iterNext, return: iterReturn, throw: iterThrow } = iter;

          iter.next = (...args) => ${traceNext}(iterNext, ctx, iter, ...args);
          iter.return = (...args) => ${traceNext}(iterReturn, ctx, iter, ...args);
          iter.throw = (...args) => ${traceNext}(iterThrow, ctx, iter, ...args);

          const origAsyncIterator = iter[Symbol.asyncIterator];
          if (typeof origAsyncIterator === 'function') {
            iter[Symbol.asyncIterator] = function apmWrappedAsyncIterator () {
              const inner = origAsyncIterator.call(iter);
              if (inner === iter) {
                return iter;
              }
              return wrap(inner);
            };
          }

          return iter;
        };
        const ctx = {
          arguments,
          self: this,
          moduleVersion: "1.0.0"
        };
        const iter = ${channelVariable}.traceSync(__apm$traced, ctx);

        if (typeof iter.then !== 'function') return wrap(iter);

        return iter.then(result => {
          ctx.result = result;

          ${channelVariable}.asyncStart.publish(ctx);
          ${channelVariable}.asyncEnd.publish(ctx);

          return wrap(result);
        }, err => {
          ctx.error = err;

          ${channelVariable}.error.publish(ctx);
          ${channelVariable}.asyncStart.publish(ctx);
          ${channelVariable}.asyncEnd.publish(ctx);

          return Promise.reject(err);
        });
      };
    }
  `).body[0].body // Extract only block statement of function body.

  // Replace the right-hand side assignment of `const __apm$wrapped = () => {}`.
  query(wrapper, '[id.name=__apm$wrapped]')[0].init = node

  return wrapper
}
