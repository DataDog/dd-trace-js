'use strict'

const contexts = new WeakMap()

/**
 * Associate a public context wrapper with its Datadog propagation context.
 *
 * @param {object} wrapper
 * @param {import('./span_context')} context
 */
function registerDatadogContext (wrapper, context) {
  contexts.set(wrapper, context)
}

/**
 * Resolve the Datadog propagation context behind a public context wrapper.
 *
 * @param {object} wrapper
 * @returns {import('./span_context') | undefined}
 */
function getDatadogContext (wrapper) {
  return contexts.get(wrapper)
}

module.exports = { getDatadogContext, registerDatadogContext }
