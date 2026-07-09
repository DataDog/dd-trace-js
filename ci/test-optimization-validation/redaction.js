'use strict'

const REDACTED = '<redacted>'

const SECRET_NAME_SOURCE = [
  'API_?KEY',
  'APP_?KEY',
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSPHRASE',
  'CREDENTIAL',
  'PRIVATE_?KEY',
  'CLIENT_?SECRET',
  'ACCESS_?KEY',
  'COOKIE',
].join('|')
const EXACT_SECRET_ASSIGNMENT_NAME_SOURCE = [
  SECRET_NAME_SOURCE,
  'AUTH',
  'AUTHORIZATION',
  'PASS',
  'SET-COOKIE',
].join('|')
const SECRET_NAME_CHARS = String.raw`[A-Za-z0-9_.-]`
const SECRET_ASSIGNMENT_NAME_SOURCE = [
  String.raw`(?:${EXACT_SECRET_ASSIGNMENT_NAME_SOURCE})`,
  String.raw`[A-Za-z_]${SECRET_NAME_CHARS}*(?:${SECRET_NAME_SOURCE})${SECRET_NAME_CHARS}*`,
  String.raw`[A-Za-z_]${SECRET_NAME_CHARS}*[-_]PASS`,
  String.raw`[A-Za-z_]${SECRET_NAME_CHARS}*[-_]AUTH(?:ORIZATION)?`,
  'PASS',
  'AUTH',
  'AUTHORIZATION',
  'COOKIE',
  'SET-COOKIE',
].join('|')
const SECRET_FLAG_SOURCE = [
  'api-key',
  'app-key',
  'token',
  'secret',
  'password',
  'pass',
  'credential',
  'private-key',
  'client-secret',
  'access-key',
  'auth',
].join('|')
const SECRET_VALUE_SOURCE = String.raw`("[^"]*"|'[^']*'|[^\s,;]+)`
const SENSITIVE_NAME_PATTERN = new RegExp(`(?:${SECRET_NAME_SOURCE})`, 'i')
const SENSITIVE_AUTH_NAME_PATTERN = /(?:^|_)AUTH(?:ORIZATION)?(?:_|$)/i
const SENSITIVE_COOKIE_NAME_PATTERN = /(?:^|_)SET_?COOKIE(?:_|$)|(?:^|_)COOKIE(?:_|$)/i
const SENSITIVE_PASS_NAME_PATTERN = /(?:^|_)PASS(?:_|$)/i
const SECRET_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`\b(${SECRET_ASSIGNMENT_NAME_SOURCE})\s*=\s*` + SECRET_VALUE_SOURCE,
  'gi'
)
const SECRET_FLAG_PATTERN = new RegExp(
  String.raw`(--(?:${SECRET_FLAG_SOURCE})(?:-[A-Za-z0-9]+)*)(=|\s+)` + SECRET_VALUE_SOURCE,
  'gi'
)
const SECRET_FLAG_NAME_PATTERN = new RegExp(
  String.raw`^--(?:${SECRET_FLAG_SOURCE})(?:-[A-Za-z0-9]+)*$`,
  'i'
)
const AUTH_HEADER_PATTERN = /\b(Bearer)\s+\S+/gi
const SECRET_HEADER_NAME_SOURCE = [
  'dd-api-key',
  'x-api-key',
  'api-key',
  'authorization',
  'proxy-authorization',
  'token',
  'cookie',
  'set-cookie',
  SECRET_ASSIGNMENT_NAME_SOURCE,
].join('|')
const SECRET_HEADER_PATTERN = new RegExp(
  String.raw`\b((?:${SECRET_HEADER_NAME_SOURCE}))\s*:\s*("[^"]*"|'[^']*'|[^\r\n,}]+)`,
  'gi'
)
const URL_CREDENTIAL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi

const ENV_CONTAINER_KEYS = new Set([
  'safeEnv',
  'workflowEnv',
  'jobEnv',
  'stepEnv',
  'inheritedEnv',
])

const SECRET_NAME_ONLY_KEYS = new Set([
  'requiredEnvVars',
  'requiredSecretEnvVars',
  'secretEnvVars',
  'missingEnvVars',
  'originalSecretEnvVars',
])

/**
 * Redacts secret-like values from arbitrary report data before it is serialized.
 *
 * @param {unknown} value data to sanitize
 * @returns {unknown} sanitized copy
 */
function sanitizeForReport (value) {
  return sanitizeValue(value, new WeakSet())
}

/**
 * Redacts secret-like values from an environment variable map.
 *
 * @param {object|undefined} env environment map
 * @returns {object|undefined} sanitized environment map
 */
function sanitizeEnv (env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return

  const sanitized = {}
  for (const [name, value] of Object.entries(env)) {
    sanitized[name] = sanitizeEnvValue(name, value)
  }
  if (Object.keys(sanitized).length > 0) return sanitized
}

/**
 * Redacts a single environment value when its name is secret-like.
 *
 * @param {string} name environment variable name
 * @param {unknown} value environment variable value
 * @returns {string|undefined} sanitized environment variable value
 */
function sanitizeEnvValue (name, value) {
  if (isSensitiveName(name)) return REDACTED
  if (value === undefined) return
  return sanitizeString(String(value))
}

/**
 * Redacts common inline secret forms from strings.
 *
 * @param {string} value string to sanitize
 * @returns {string} sanitized string
 */
function sanitizeString (value) {
  return value
    .replaceAll(SECRET_ASSIGNMENT_PATTERN, `$1=${REDACTED}`)
    .replaceAll(SECRET_FLAG_PATTERN, `$1$2${REDACTED}`)
    .replaceAll(SECRET_HEADER_PATTERN, `$1: ${REDACTED}`)
    .replaceAll(AUTH_HEADER_PATTERN, `$1 ${REDACTED}`)
    .replaceAll(URL_CREDENTIAL_PATTERN, `$1${REDACTED}$3`)
}

/**
 * Returns whether a key or variable name usually carries secret values.
 *
 * @param {string} name key or environment variable name
 * @returns {boolean} true when values under this name should be redacted
 */
function isSensitiveName (name) {
  const normalized = String(name || '').replaceAll(/[-.]/g, '_')
  return SENSITIVE_NAME_PATTERN.test(normalized) ||
    SENSITIVE_AUTH_NAME_PATTERN.test(normalized) ||
    SENSITIVE_COOKIE_NAME_PATTERN.test(normalized) ||
    SENSITIVE_PASS_NAME_PATTERN.test(normalized)
}

function sanitizeValue (value, seen, key) {
  if (typeof value === 'string') {
    if (key && isSensitiveName(key) && !SECRET_NAME_ONLY_KEYS.has(key)) return REDACTED
    return sanitizeString(value)
  }

  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  if (Array.isArray(value)) {
    const sanitized = sanitizeArray(value, seen, key)
    seen.delete(value)
    return sanitized
  }

  if (key && ENV_CONTAINER_KEYS.has(key)) {
    const env = sanitizeEnv(value)
    seen.delete(value)
    return env || {}
  }

  const sanitized = {}
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (isSensitiveName(entryKey) && !SECRET_NAME_ONLY_KEYS.has(entryKey)) {
      sanitized[entryKey] = REDACTED
      continue
    }
    sanitized[entryKey] = sanitizeValue(entryValue, seen, entryKey)
  }
  seen.delete(value)
  return sanitized
}

/**
 * Redacts secret flag/value pairs in arrays such as argv before sanitizing nested values.
 *
 * @param {Array<unknown>} value array to sanitize
 * @param {WeakSet<object>} seen objects currently being sanitized
 * @param {string|undefined} key parent key
 * @returns {Array<unknown>} sanitized array
 */
function sanitizeArray (value, seen, key) {
  const sanitized = []

  for (let index = 0; index < value.length; index++) {
    const item = value[index]
    if (typeof item === 'string' && SECRET_FLAG_NAME_PATTERN.test(item) && index + 1 < value.length) {
      sanitized.push(sanitizeString(item), REDACTED)
      index++
      continue
    }

    sanitized.push(sanitizeValue(item, seen, key))
  }

  return sanitized
}

module.exports = {
  sanitizeEnv,
  sanitizeEnvValue,
  sanitizeForReport,
  sanitizeString,
}
