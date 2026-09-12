'use strict'

const { PromptAPIError } = require('./errors')
const { extractTemplate, renderChat, safeSubstitute } = require('./util')

class ManagedPrompt {
  #uuid
  #versionUuid

  /**
   * @param {{id: string, version: string | number, label?: string, template: string | import('./util').Message[],
   * source: string, uuid?: string, versionUuid?: string, labels?: string[]}} options
   */
  constructor ({ id, version, label, template, source, uuid, versionUuid, labels }) {
    this.id = String(id)
    this.version = String(version)
    this.label = label
    this.template = template
    this.source = source
    this.labels = labels
    this.#uuid = uuid
    this.#versionUuid = versionUuid
    Object.freeze(this)
  }

  get isChat () {
    return Array.isArray(this.template)
  }

  /**
   * Render this prompt with the supplied variables.
   * @param {Record<string, unknown>} variables
   * @returns {string | import('./util').Message[]}
   */
  render (variables = {}) {
    return typeof this.template === 'string'
      ? safeSubstitute(this.template, variables)
      : renderChat(this.template, variables)
  }

  /**
   * Render this prompt as chat messages.
   * @param {Record<string, unknown>} variables
   * @returns {import('./util').Message[]}
   */
  renderChat (variables = {}) {
    return renderChat(this.template, variables)
  }

  /**
   * Convert this prompt to the object accepted by llmobs.annotate().
   * @param {Record<string, unknown>} variables
   * @returns {import('../../../../../index').llmobs.Prompt}
   */
  toAnnotation (variables = {}) {
    const annotation = {
      id: this.id,
      version: this.version,
      template: this.template,
    }
    const entries = Object.entries(variables)
    if (entries.length > 0) {
      annotation.variables = Object.fromEntries(entries.map(([key, value]) => [key, String(value)]))
    }
    if (this.source === 'registry' && this.label !== undefined) annotation.tags = { label: this.label }
    return annotation
  }

  _serialize () {
    return {
      id: this.id,
      version: this.version,
      label: this.label,
      template: this.template,
      source: this.source,
      labels: this.labels,
      uuid: this.#uuid,
      versionUuid: this.#versionUuid,
    }
  }

  static fromCache (data) {
    return new ManagedPrompt(data)
  }

  /**
   * @param {Record<string, unknown>} payload
   * @param {{label?: string, source?: 'registry' | 'fallback' | 'cache'}} options
   * @returns {ManagedPrompt}
   */
  static fromResponse (payload, { label, source = 'registry' } = {}) {
    const template = extractTemplate(payload)
    if (template === undefined) throw new PromptAPIError('Prompt response is missing a template')
    const responseLabel = payload.label ?? label
    const responseVersionUuid = payload.prompt_version_uuid ?? payload.ID ?? payload.id_version
    return new ManagedPrompt({
      id: String(payload.prompt_id ?? payload.id),
      version: String(payload.user_version ?? payload.version),
      label: typeof responseLabel === 'string' ? responseLabel : undefined,
      template,
      source,
      uuid: typeof payload.prompt_uuid === 'string' ? payload.prompt_uuid : undefined,
      versionUuid: typeof responseVersionUuid === 'string'
        ? responseVersionUuid
        : undefined,
      labels: Array.isArray(payload.labels) ? payload.labels.filter(label => typeof label === 'string') : undefined,
    })
  }

  /**
   * @param {string | import('../../../../../index').llmobs.PromptMessage[] | object | (() => unknown)} fallback
   * @param {string} id
   * @returns {ManagedPrompt}
   */
  static fromFallback (fallback, id) {
    const value = typeof fallback === 'function' ? fallback() : fallback
    if (typeof value === 'string' || Array.isArray(value)) {
      return new ManagedPrompt({ id, version: 'fallback', template: value, source: 'fallback' })
    }
    const template = extractTemplate(value ?? {})
    if (template === undefined) {
      throw new TypeError('Fallback must contain a template or chat_template')
    }
    return new ManagedPrompt({
      id,
      version: value?.version ?? 'fallback',
      label: value?.label,
      template,
      source: 'fallback',
    })
  }
}

module.exports = { ManagedPrompt }
