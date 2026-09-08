'use strict'

const crypto = require('node:crypto')

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}|\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g

/**
 * @typedef {object} Message
 * @property {string} role
 * @property {string} content
 */

/**
 * Extract and normalize a prompt template from a registry response.
 * @param {Record<string, unknown>} payload
 * @returns {string | Message[] | undefined}
 */
function extractTemplate (payload = {}) {
  const template = typeof payload.template === 'string' || Array.isArray(payload.template)
    ? payload.template
    : typeof payload.chat_template === 'string' || Array.isArray(payload.chat_template)
      ? payload.chat_template
      : undefined

  if (typeof template === 'string') return template
  if (!Array.isArray(template)) return

  return template
    .filter(message => message && typeof message.content === 'string')
    .map(message => ({ role: typeof message.role === 'string' ? message.role : 'user', content: message.content }))
}

/**
 * Safely substitute Python and mustache-style variables, leaving missing values unchanged.
 * @param {string} template
 * @param {Record<string, unknown>} variables
 * @returns {string}
 */
function safeSubstitute (template, variables = {}) {
  const escapedOpen = '\u0000OPEN\u0000'
  const escapedClose = '\u0000CLOSE\u0000'
  let value = String(template)
    .replaceAll('{{{{', escapedOpen)
    .replaceAll('}}}}', escapedClose)

  value = value.replaceAll(VARIABLE_PATTERN, (match, doubleName, singleName) => {
    const name = doubleName ?? singleName
    if (Object.hasOwn(variables, name)) return String(variables[name])
    return doubleName === undefined ? match : `__DD_MISSING_DOUBLE_${name}__`
  })

  return value
    .replaceAll('{{', '{')
    .replaceAll('}}', '}')
    .replaceAll(escapedOpen, '{{')
    .replaceAll(escapedClose, '}}')
    .replaceAll(/__DD_MISSING_DOUBLE_([A-Za-z_][A-Za-z0-9_]*)__/g, '{{$1}}')
}

/**
 * Render a text or chat prompt as chat messages.
 * @param {string | Message[]} template
 * @param {Record<string, unknown>} variables
 * @returns {Message[]}
 */
function renderChat (template, variables = {}) {
  if (typeof template === 'string') return [{ role: 'user', content: safeSubstitute(template, variables) }]
  return template.map(message => ({ ...message, content: safeSubstitute(message.content, variables) }))
}

/**
 * Extract a useful error detail from an API response body.
 * @param {string} text
 * @returns {string}
 */
function extractErrorDetail (text) {
  const raw = String(text ?? '')
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
      const error = parsed.errors[0]
      return String(error?.detail ?? error?.title ?? raw).trim().slice(0, 500)
    }
    if (parsed?.error !== undefined) {
      const detail = parsed.error && typeof parsed.error === 'object'
        ? parsed.error.detail ?? parsed.error.message ?? parsed.error
        : parsed.error
      return String(detail).trim().slice(0, 500)
    }
    if (parsed?.message !== undefined) return String(parsed.message).trim().slice(0, 500)
    if (parsed?.detail !== undefined) return String(parsed.detail).trim().slice(0, 500)
  } catch {}
  return raw.trim().slice(0, 500)
}

/**
 * Escape a prompt ID for use in a URL path.
 * @param {string} id
 * @returns {string}
 */
function escapeId (id) {
  return encodeURIComponent(id)
}

/**
 * Build a deterministic cache key for a prompt request.
 * @param {{id: string, version?: string | number, label?: string, env?: string,
 * targetingKey?: string, attributes?: Record<string, unknown>}} options
 * @returns {string}
 */
function cacheKey ({ id, version, label, env, targetingKey, attributes }) {
  const sort = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]))
  }
  return JSON.stringify([
    id,
    version ?? null,
    label ?? null,
    env ?? null,
    targetingKey ?? null,
    attributes ? sort(attributes) : null,
  ])
}

/**
 * Parse the prompt ID component from a cache key.
 * @param {string} key
 * @returns {{id: string}}
 */
function parseCacheKey (key) {
  try {
    const parsed = JSON.parse(key)
    return { id: parsed[0] }
  } catch {
    return { id: key.split(':')[0] }
  }
}

/**
 * Hash a cache key for a warm-cache filename.
 * @param {string} key
 * @returns {string}
 */
function cacheHash (key) {
  return crypto.createHash('sha256').update(key).digest('hex')
}

module.exports = {
  extractTemplate,
  safeSubstitute,
  renderChat,
  extractErrorDetail,
  escapeId,
  cacheKey,
  parseCacheKey,
  cacheHash,
}
