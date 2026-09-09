'use strict'

const VARIABLE_PATTERN = /(?<!\{)(?:\{\{\s*(\w+)\s*\}\}(?!\})|\{\s*(\w+)\s*\}(?!\}))/g

function isMessage (value) {
  return value && typeof value === 'object' && typeof value.role === 'string' && typeof value.content === 'string'
}

function isPlaceholder (value) {
  return value && typeof value === 'object' && value.type === 'placeholder' && typeof value.name === 'string'
}

function render (template, variables) {
  return template.replaceAll(VARIABLE_PATTERN, (match, doubleName, singleName) => {
    const name = doubleName ?? singleName
    return Object.hasOwn(variables, name) ? String(variables[name]) : match
  })
}

class ManagedPrompt {
  /**
   * @param {object} data
   * @param {string} data.id
   * @param {string} data.version
   * @param {'registry'|'cache'|'fallback'|'ff'|'resolve'} data.source
   * @param {string | Array<{role: string, content: string} | {type: 'placeholder', name: string}>} data.template
   * @param {string} [data.promptUuid]
   * @param {string} [data.promptVersionUuid]
   */
  constructor ({ id, version, source, template, promptUuid, promptVersionUuid }) {
    this.id = id
    this.version = version
    this.source = source
    this.template = Array.isArray(template)
      ? Object.freeze(template.map(item => Object.freeze({ ...item })))
      : template
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
    return this.template.flatMap(item => {
      if (!isPlaceholder(item)) return [{ ...item, content: render(item.content, variables) }]
      if (!Object.hasOwn(variables, item.name)) {
        throw new TypeError(`Missing message placeholder variable '${item.name}'`)
      }
      const messages = variables[item.name]
      if (!Array.isArray(messages) || !messages.every(isMessage)) {
        throw new TypeError(`Invalid message placeholder variable '${item.name}': expected an array of messages`)
      }
      return messages.map(message => ({ ...message }))
    })
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
    const placeholderNames = new Set(Array.isArray(this.template)
      ? this.template.filter(isPlaceholder).map(item => item.name)
      : [])
    const entries = Object.entries(variables ?? {}).filter(([name]) => !placeholderNames.has(name))
    if (entries.length) {
      annotation.variables = Object.fromEntries(entries.map(([name, value]) => [name, String(value)]))
    }
    if (this.promptUuid) annotation.promptUuid = this.promptUuid
    if (this.promptVersionUuid) annotation.promptVersionUuid = this.promptVersionUuid
    return annotation
  }

  /**
   * Convert a caller fallback to a managed prompt.
   * @param {string} promptId
   * @param {string | object | Array<{role: string, content: string} | {type: 'placeholder', name: string}> |
   *   (() => string | object | Array<{role: string, content: string} | {type: 'placeholder', name: string}>)} fallback
   * @returns {ManagedPrompt}
   */
  static fromFallback (promptId, fallback) {
    const value = typeof fallback === 'function' ? fallback() : fallback
    const promptLike = value && !Array.isArray(value) && typeof value === 'object'
    const template = promptLike ? value.template : value
    const validTemplate = typeof template === 'string' || (
      Array.isArray(template) && template.every(item => isMessage(item) || isPlaceholder(item))
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
