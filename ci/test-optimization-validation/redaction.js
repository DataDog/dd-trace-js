'use strict'

const REDACTED = '<redacted>'
const MAX_SANITIZE_DEPTH = 128
const TRUNCATED_NESTING = '[Truncated: nesting exceeds redaction limit]'

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
  'PAT',
  'JWT',
  'WEBHOOK(?:_URL)?',
].join('|')
const SECRET_NAME_CHARS = String.raw`[A-Za-z0-9_.-]`
const SECRET_ASSIGNMENT_NAME_SOURCE = [
  String.raw`(?:${EXACT_SECRET_ASSIGNMENT_NAME_SOURCE})`,
  String.raw`[A-Za-z_]${SECRET_NAME_CHARS}*(?:${SECRET_NAME_SOURCE})${SECRET_NAME_CHARS}*`,
  String.raw`[A-Za-z_]${SECRET_NAME_CHARS}*[-_]PASS`,
  String.raw`[A-Za-z_]${SECRET_NAME_CHARS}*[-_]AUTH(?:ORIZATION)?`,
  String.raw`[A-Za-z_]${SECRET_NAME_CHARS}*[-_](?:PAT|JWT|WEBHOOK(?:_URL)?)`,
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
const SENSITIVE_TOKEN_ALIAS_NAME_PATTERN = /(?:^|_)(?:PAT|JWT|WEBHOOK(?:_URL)?)(?:_|$)/i
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
const AUTH_HEADER_PATTERN = /\b(Bearer)\s+([^\s'",}\]]+)/gi
const AUTH_SCHEME_ASSIGNMENT_QUOTED_PATTERN = new RegExp(
  String.raw`\b(${SECRET_ASSIGNMENT_NAME_SOURCE})\s*=\s*(["'])(?:Bearer|Basic)\s+.*?\2`,
  'gi'
)
const AUTH_SCHEME_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`\b(${SECRET_ASSIGNMENT_NAME_SOURCE})\s*=\s*(?:Bearer|Basic)\s+[^\s,;]+`,
  'gi'
)
const DEFAULT_IGNORABLE_PATTERN = /\p{Default_Ignorable_Code_Point}/gu
const DEFAULT_IGNORABLE_TEST_PATTERN = /\p{Default_Ignorable_Code_Point}/u
const CONTROL_CHARACTER_TEST_PATTERN = /\p{Cc}/u
const UNSAFE_CONTROL_SOURCE = String.raw`[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]`
const UNSAFE_CONTROL_PATTERN = new RegExp(UNSAFE_CONTROL_SOURCE, 'g')
const UNSAFE_CONTROL_TEST_PATTERN = new RegExp(UNSAFE_CONTROL_SOURCE)
const PRIVATE_KEY_BLOCK_PATTERN =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g
const JWT_VALUE_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
const KNOWN_TOKEN_VALUE_PATTERN =
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g
const SECRET_HEADER_ENV_NAME_SOURCE = [
  String.raw`(?:${SECRET_NAME_SOURCE}|PAT|JWT|WEBHOOK(?:_URL)?)`,
  String.raw`[A-Za-z_]${SECRET_NAME_CHARS}*(?:${SECRET_NAME_SOURCE})${SECRET_NAME_CHARS}*`,
  String.raw`[A-Za-z_]${SECRET_NAME_CHARS}*[-_]AUTH(?:ORIZATION)?`,
  String.raw`[A-Za-z_]${SECRET_NAME_CHARS}*[-_](?:PAT|JWT|WEBHOOK(?:_URL)?)`,
].join('|')
const SECRET_HEADER_NAME_SOURCE = [
  'dd-api-key',
  'x-api-key',
  'api-key',
  'authorization',
  'proxy-authorization',
  'token',
  'cookie',
  'set-cookie',
  SECRET_HEADER_ENV_NAME_SOURCE,
].join('|')
const SECRET_HEADER_PATTERN = new RegExp(
  String.raw`\b((?:${SECRET_HEADER_NAME_SOURCE}))\s*:\s*("[^"]*"|'[^']*'|[^\r\n,}]+)`,
  'gi'
)
const URL_CREDENTIAL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)([^@\s/]+)(@)/gi
const GITHUB_SECRET_REFERENCE_PATTERN =
  /(?:\b[A-Za-z_][A-Za-z0-9_.-]*\s*[:=]\s*)?\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g
const SAFE_REFERENCE_MARKER_PATTERN = /DDCIVARREF([0-9]+)X/g

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
  return sanitizeValue(value, new WeakSet(), undefined, 0)
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
  const references = []
  const protectedValue = value.replaceAll(GITHUB_SECRET_REFERENCE_PATTERN, reference => {
    return `DDCIVARREF${references.push(reference) - 1}X`
  })
  const sanitized = protectedValue
    .replaceAll(DEFAULT_IGNORABLE_PATTERN, '')
    .replaceAll(UNSAFE_CONTROL_PATTERN, '')
    .replaceAll(PRIVATE_KEY_BLOCK_PATTERN, '<redacted-private-key>')
    .replaceAll(JWT_VALUE_PATTERN, REDACTED)
    .replaceAll(KNOWN_TOKEN_VALUE_PATTERN, REDACTED)
    .replaceAll(AUTH_SCHEME_ASSIGNMENT_QUOTED_PATTERN, `$1=${REDACTED}`)
    .replaceAll(AUTH_SCHEME_ASSIGNMENT_PATTERN, `$1=${REDACTED}`)
    .replaceAll(SECRET_ASSIGNMENT_PATTERN, `$1=${REDACTED}`)
    .replaceAll(SECRET_FLAG_PATTERN, `$1$2${REDACTED}`)
    .replaceAll(SECRET_HEADER_PATTERN, `$1: ${REDACTED}`)
    .replaceAll(AUTH_HEADER_PATTERN, `$1 ${REDACTED}`)
    .replaceAll(URL_CREDENTIAL_PATTERN, `$1${REDACTED}$3`)

  return sanitized.replaceAll(SAFE_REFERENCE_MARKER_PATTERN, (marker, index) => references[Number(index)] || marker)
}

/**
 * Detects default-ignorable Unicode characters that can conceal executable text or secret names.
 *
 * @param {unknown} value candidate text
 * @returns {boolean} true when the text contains a default-ignorable Unicode character
 */
function hasUnicodeDefaultIgnorable (value) {
  return DEFAULT_IGNORABLE_TEST_PATTERN.test(String(value ?? ''))
}

function hasUnsafeInvisibleCharacter (value) {
  const text = String(value ?? '')
  return hasUnicodeDefaultIgnorable(text) || UNSAFE_CONTROL_TEST_PATTERN.test(text)
}

function hasUnsafeExecutionCharacter (value) {
  return hasUnicodeDefaultIgnorable(value) || CONTROL_CHARACTER_TEST_PATTERN.test(String(value ?? ''))
}

/**
 * Makes untrusted text safe to print to an interactive terminal while preserving line breaks.
 *
 * @param {unknown} value console value
 * @returns {string} inert console text
 */
function sanitizeConsoleText (value) {
  let result = ''
  for (const character of sanitizeString(String(value ?? ''))) {
    const code = character.charCodeAt(0)
    result += character === '\n' || character === '\t' || code > 0x1F && code !== 0x7F
      ? character
      : String.raw`\u${code.toString(16).padStart(4, '0')}`
  }
  return result
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
    SENSITIVE_PASS_NAME_PATTERN.test(normalized) ||
    SENSITIVE_TOKEN_ALIAS_NAME_PATTERN.test(normalized)
}

function sanitizeValue (value, seen, key, depth) {
  if (typeof value === 'string') {
    if (key && isSensitiveName(key) && !SECRET_NAME_ONLY_KEYS.has(key)) return REDACTED
    return sanitizeString(value)
  }

  if (value === null || typeof value !== 'object') return value
  if (depth > MAX_SANITIZE_DEPTH) return TRUNCATED_NESTING
  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  if (Array.isArray(value)) {
    const sanitized = sanitizeArray(value, seen, key, depth)
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
    sanitized[entryKey] = sanitizeValue(entryValue, seen, entryKey, depth + 1)
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
 * @param {number} depth current nesting depth
 * @returns {Array<unknown>} sanitized array
 */
function sanitizeArray (value, seen, key, depth) {
  const sanitized = []

  for (let index = 0; index < value.length; index++) {
    const item = value[index]
    if (typeof item === 'string' && SECRET_FLAG_NAME_PATTERN.test(item) && index + 1 < value.length) {
      sanitized.push(sanitizeString(item))
      if (!isFlagToken(value[index + 1])) {
        sanitized.push(REDACTED)
        index++
      }
      continue
    }

    sanitized.push(sanitizeValue(item, seen, key, depth + 1))
  }

  return sanitized
}

function isFlagToken (value) {
  return typeof value === 'string' && /^-{1,2}\S/.test(value)
}

module.exports = {
  hasUnsafeExecutionCharacter,
  hasUnsafeInvisibleCharacter,
  isSensitiveName,
  sanitizeConsoleText,
  sanitizeEnv,
  sanitizeEnvValue,
  sanitizeForReport,
  sanitizeString,
}
