'use strict'

const trackedPrompts = new WeakMap()
let config

/**
 * Use the tracer's live configuration when deciding whether renders need a carrier.
 * @param {import('../../config/config-base')} tracerConfig
 * @returns {void}
 */
function configurePromptTracking (tracerConfig) {
  config = tracerConfig
}

function trackPrompt (rendered, prompt) {
  if (!config?.llmobs?.DD_LLMOBS_ENABLED) return rendered

  const tracked = typeof rendered === 'string' ? new Object(rendered) : rendered
  trackedPrompts.set(tracked, prompt)
  return tracked
}

/**
 * Capture the first exact managed-prompt carrier in an instrumented call and replace a boxed text
 * carrier with its primitive value before the library receives it.
 * @param {unknown} ctx
 * @returns {Record<string, unknown> | undefined}
 */
function captureTrackedPrompt (ctx) {
  if (!ctx || typeof ctx !== 'object') return
  const context = /** @type {Record<string, unknown>} */ (ctx)

  for (const field of ['args', 'arguments']) {
    const args = context[field]
    if (!Array.isArray(args)) continue

    for (let index = 0; index < args.length; index++) {
      const result = captureValue(args[index])
      if (!result) continue
      args[index] = result.value
      return result.prompt
    }
  }

  for (const field of ['options', 'request', 'event']) {
    const result = captureValue(context[field])
    if (!result) continue
    context[field] = result.value
    return result.prompt
  }
}

/**
 * Capture an exact carrier or a carrier used as a direct field of one call argument.
 * @param {unknown} value
 * @returns {{value: unknown, prompt: Record<string, unknown>} | undefined}
 */
function captureValue (value) {
  if (!value || typeof value !== 'object') return

  const prompt = trackedPrompts.get(value)
  if (prompt) {
    return { value: Array.isArray(value) ? value : value.valueOf(), prompt }
  }

  let entries
  try {
    entries = Object.entries(value)
  } catch {
    return
  }

  for (const [key, candidate] of entries) {
    if (!candidate || typeof candidate !== 'object') continue
    const prompt = trackedPrompts.get(candidate)
    if (!prompt) continue

    if (!Array.isArray(candidate)) {
      try {
        value[key] = candidate.valueOf()
      } catch {}
    }
    return { value, prompt }
  }
}

module.exports = { captureTrackedPrompt, configurePromptTracking, trackPrompt }
