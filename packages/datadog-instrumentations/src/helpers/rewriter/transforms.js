'use strict'

// Custom transforms registered via InstrumentationMatcher.addTransform().
//
// Use this file for transforms that are not yet supported upstream in
// @apm-js-collab/code-transformer (Orchestrion) or that cannot land there
// for dd-trace-specific reasons. Once a transform is available natively in
// the library, replace the custom registration with the built-in option and
// remove the entry here.

const { parse, query } = require('./compiler')

const tracingChannelPredicate = (node) => (
  node.specifiers?.[0]?.local?.name === 'tr_ch_apm_tracingChannel' ||
    node.declarations?.[0]?.id?.properties?.[0]?.value?.name === 'tr_ch_apm_tracingChannel'
)

const transforms = module.exports = {
  /**
   * @param {{ dcModule: string, moduleType: 'esm' | 'cjs' }} state
   * @param {import('estree').Program} node
   */
  tracingChannelImport ({ dcModule, moduleType }, node) {
    if (node.body.some(tracingChannelPredicate)) return

    // The vendored matcher state exposes `moduleType` (`esm` / `cjs`), so we
    // read that field directly. Naming it `sourceType` here used to silently
    // pick the CJS branch for every ESM file, leaving `require()` baked into
    // pure ESM modules like `@langchain/langgraph/dist/pregel/index.js`.
    const isModule = moduleType === 'esm'

    const index = node.body.findIndex(child => child.directive === 'use strict')
    const code = isModule
      ? `import tr_ch_apm_dc from "${dcModule}"; const {tracingChannel: tr_ch_apm_tracingChannel} = tr_ch_apm_dc`
      : `const {tracingChannel: tr_ch_apm_tracingChannel} = require("${dcModule}")`

    node.body.splice(index + 1, 0, ...parse(code, { isModule }).body)
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

  waitForAsyncEnd,
}

/**
 * Injects a wait for `ctx.asyncEndPromise` into a generated `tracePromise`
 * wrapper's native-Promise fulfillment handler.
 *
 * @param {object} _state
 * @param {import('estree').CallExpression} node
 * @returns {void}
 */
function waitForAsyncEnd (_state, node) {
  const onFulfilled = node.arguments[0]
  const statements = onFulfilled?.body?.body

  if (!statements || query(onFulfilled.body, '[id.name=__apm$asyncEndPromise]').length > 0) {
    return
  }

  const returnIndex = statements.findIndex(statement => (
    statement.type === 'ReturnStatement' && statement.argument?.name === 'result'
  ))

  if (returnIndex === -1) return

  const waitStatements = parse(`
    function wrapper () {
      const __apm$asyncEndPromise = __apm$ctx.asyncEndPromise;
      if (__apm$asyncEndPromise && typeof __apm$asyncEndPromise.then === 'function') {
        return __apm$asyncEndPromise.then(() => result, () => result);
      }
    }
  `).body[0].body.body

  statements.splice(returnIndex, 0, ...waitStatements)
}
