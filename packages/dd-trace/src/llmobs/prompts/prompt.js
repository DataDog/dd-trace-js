'use strict'

const VARIABLE_PATTERN = /\{\{?\s*(\w+)\s*\}\}?/g
const PROMPT_SOURCES = new Set(['registry', 'cache', 'fallback', 'ff', 'resolve'])

function copyTemplate (template) {
  if (!Array.isArray(template)) return template
  return Object.freeze(template.map(message => Object.freeze({ role: message.role, content: message.content })))
}

function render (template, variables) {
  return template.replaceAll(VARIABLE_PATTERN, (match, name) => {
    return Object.hasOwn(variables, name) ? String(variables[name]) : match
  })
}

function stringifyVariables (variables) {
  if (!variables) return
  const result = {}
  let hasVariables = false
  for (const [name, value] of Object.entries(variables)) {
    result[name] = String(value)
    hasVariables = true
  }
  return hasVariables ? result : undefined
}

class ManagedPrompt {
  /**
   * @param {object} data
   * @param {string} data.id
   * @param {string} data.version
   * @param {'registry'|'cache'|'fallback'|'ff'|'resolve'} data.source
   * @param {string | Array<{role: string, content: string}>} data.template
   * @param {string} [data.promptUuid]
   * @param {string} [data.promptVersionUuid]
   */
  constructor ({ id, version, source, template, promptUuid, promptVersionUuid }) {
    this.id = id
    this.version = version
    this.source = source
    this.template = copyTemplate(template)
    this.promptUuid = promptUuid
    this.promptVersionUuid = promptVersionUuid
    Object.freeze(this)
  }

  /**
   * Render the prompt without changing its stored template.
   * @param {Record<string, unknown>} [variables]
   * @returns {string | Array<{role: string, content: string}>}
   */
  format (variables = {}) {
    if (typeof this.template === 'string') return render(this.template, variables)
    return this.template.map(message => ({ role: message.role, content: render(message.content, variables) }))
  }

  /**
   * Convert the managed prompt to the existing public annotation shape.
   * @param {Record<string, unknown>} [variables]
   * @returns {Record<string, unknown>}
   */
  toAnnotation (variables) {
    const annotation = {
      id: this.id,
      version: this.version,
      template: this.template,
    }
    const normalizedVariables = stringifyVariables(variables)
    if (normalizedVariables) annotation.variables = normalizedVariables
    if (this.promptUuid) annotation.promptUuid = this.promptUuid
    if (this.promptVersionUuid) annotation.promptVersionUuid = this.promptVersionUuid
    return annotation
  }

  /**
   * Serialize the immutable prompt for the warm cache.
   * @returns {object}
   */
  _serialize () {
    return {
      id: this.id,
      version: this.version,
      source: this.source,
      template: this.template,
      promptUuid: this.promptUuid,
      promptVersionUuid: this.promptVersionUuid,
    }
  }

  /**
   * Restore a prompt from the warm cache.
   * @param {object} data
   * @returns {ManagedPrompt}
   */
  static _deserialize (data) {
    const validTemplate = typeof data?.template === 'string' || (
      Array.isArray(data?.template) && data.template.every(message => {
        return message && typeof message.role === 'string' && typeof message.content === 'string'
      })
    )
    if (
      typeof data?.id !== 'string' ||
      typeof data.version !== 'string' ||
      !PROMPT_SOURCES.has(data.source) ||
      !validTemplate ||
      (data.promptUuid !== undefined && typeof data.promptUuid !== 'string') ||
      (data.promptVersionUuid !== undefined && typeof data.promptVersionUuid !== 'string')
    ) {
      throw new TypeError('Invalid managed prompt cache entry')
    }
    return new ManagedPrompt(data)
  }

  /**
   * Copy a prompt with a different source.
   * @param {'registry'|'cache'|'fallback'|'ff'|'resolve'} source
   * @returns {ManagedPrompt}
   */
  _withSource (source) {
    if (source === this.source) return this
    return new ManagedPrompt({ ...this, source })
  }

  /**
   * Convert a caller fallback to a managed prompt.
   * @param {string} promptId
   * @param {string | object | Array<{role: string, content: string}> |
   *   (() => string | object | Array<{role: string, content: string}>)} fallback
   * @returns {ManagedPrompt}
   */
  static fromFallback (promptId, fallback) {
    const value = typeof fallback === 'function' ? fallback() : fallback
    const promptLike = value && !Array.isArray(value) && typeof value === 'object'
    return new ManagedPrompt({
      id: promptId,
      version: String(promptLike && value.version ? value.version : 'fallback'),
      source: 'fallback',
      template: promptLike ? value.template : value,
    })
  }
}

module.exports = ManagedPrompt
