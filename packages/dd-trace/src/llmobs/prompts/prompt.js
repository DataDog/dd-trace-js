'use strict'

const VARIABLE_PATTERN = /\{\{?\s*(\w+)\s*\}\}?/g

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
      template: typeof this.template === 'string' ? this.template : this.template.map(message => ({ ...message })),
    }
    const normalizedVariables = stringifyVariables(variables)
    if (normalizedVariables) annotation.variables = normalizedVariables
    if (this.promptUuid) annotation.promptUuid = this.promptUuid
    if (this.promptVersionUuid) annotation.promptVersionUuid = this.promptVersionUuid
    return annotation
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
    const template = promptLike ? value.template : value
    const validTemplate = typeof template === 'string' || (
      Array.isArray(template) && template.every(message => {
        return message && typeof message.role === 'string' && typeof message.content === 'string'
      })
    )
    if (!validTemplate) {
      throw new TypeError('Invalid prompt fallback: expected a string, chat message array, or object with a template')
    }
    return new ManagedPrompt({
      id: promptId,
      version: String(promptLike && value.version ? value.version : 'fallback'),
      source: 'fallback',
      template,
    })
  }
}

module.exports = ManagedPrompt
