'use strict'

// agents-core's `error` is a plain `{ message, data }` object, not a JS Error
// — there's no constructor to name and no stack. We tag a stable type constant
// and stringify `data` into the message so the LLMObs error shape stays
// consistent with other integrations.
const AGENTS_ERROR_TYPE = 'AgentsCoreError'

/**
 * Build the dd-trace span name from an agents-core oai-span. Handoffs collapse
 * the target agent name into snake_case under a `transfer_to_` prefix; other
 * span types use the SDK-provided name, falling back to
 * `openai_agents.<type>` (or `openai_agents.request` when even the type is
 * missing).
 *
 * @param {object} oaiSpan
 * @returns {string}
 */
function deriveSpanName (oaiSpan) {
  const spanData = oaiSpan.spanData
  if (spanData?.type === 'handoff') {
    const toAgent = spanData.to_agent || ''
    if (toAgent) return `transfer_to_${toAgent.replaceAll(' ', '_').toLowerCase()}`
  }
  if (spanData?.name) return spanData.name
  return spanData?.type ? `openai_agents.${spanData.type}` : 'openai_agents.request'
}

/**
 * Apply agents-core's error shape onto a dd-trace span. No-op when the
 * oai-span has no error attached.
 *
 * @param {object} ddSpan
 * @param {object} oaiSpan
 */
function applyError (ddSpan, oaiSpan) {
  const err = oaiSpan.error
  if (!err) return

  ddSpan.setTag('error', true)

  let errorMessage = err.message || 'Error'
  if (err.data) {
    try {
      errorMessage = JSON.stringify(err.data)
    } catch {
      // circular / non-serializable — fall back to the raw message
    }
  }

  ddSpan.setTag('error.type', AGENTS_ERROR_TYPE)
  ddSpan.setTag('error.message', errorMessage)
  ddSpan.setTag('error.stack', err.stack || '')
}

module.exports = {
  AGENTS_ERROR_TYPE,
  deriveSpanName,
  applyError,
}
