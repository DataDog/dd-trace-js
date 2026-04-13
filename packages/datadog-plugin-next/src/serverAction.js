'use strict'

/**
 * Wraps a Next.js Server Action with Datadog APM tracing.
 *
 * Creates a child span under the active HTTP span with the action name
 * as the operation name, giving visibility into which Server Action ran.
 *
 * Usage:
 * ```js
 * // app/actions.js
 * 'use server'
 * const { withDatadogServerAction } = require('dd-trace/next')
 *
 * async function greetAction(formData) {
 *   return withDatadogServerAction('greetAction', async () => {
 *     const name = formData.get('name')
 *     return `Hello, ${name}!`
 *   })
 * }
 * ```
 */
function withDatadogServerAction (actionName, action) {
  const tracer = global._ddtrace
  if (!tracer) return action()

  const activeSpan = tracer.scope().active()

  const actionSpan = tracer.startSpan(actionName, {
    childOf: activeSpan,
    tags: {
      'span.kind': 'internal',
    },
  })

  return tracer.scope().activate(actionSpan, () => {
    return action().then(
      (result) => { actionSpan.finish(); return result },
      (error) => { actionSpan.setTag('error', error); actionSpan.finish(); throw error }
    )
  })
}

module.exports = { withDatadogServerAction }
