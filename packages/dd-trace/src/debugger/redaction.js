'use strict'

// Used by both the main thread, which renders log template values, and the devtools client worker, which captures
// snapshots and compiles probe expressions, so that both redact the same identifiers.

// What a redacted value is rendered as in a log message.
const REDACTED_PLACEHOLDER = '{redacted}'

const DEFAULT_REDACTED_IDENTIFIERS = [
  '2fa',
  '_csrf',
  '_csrf_token',
  '_session',
  '_xsrf',
  'access_token',
  'aiohttp_session',
  'api_key',
  'apisecret',
  'apisignature',
  'applicationkey',
  'appkey',
  'auth',
  'authtoken',
  'authorization',
  'cc_number',
  'certificatepin',
  'cipher',
  'client_secret',
  'clientid',
  'connect.sid',
  'connectionstring',
  'cookie',
  'credentials',
  'creditcard',
  'csrf',
  'csrf_token',
  'cvv',
  'databaseurl',
  'db_url',
  'encryption_key',
  'encryptionkeyid',
  'geo_location',
  'gpg_key',
  'ip_address',
  'jti',
  'jwt',
  'license_key',
  'masterkey',
  'mysql_pwd',
  'nonce',
  'oauth',
  'oauthtoken',
  'otp',
  'passhash',
  'passwd',
  'password',
  'passwordb',
  'pem_file',
  'pgp_key',
  'PHPSESSID',
  'pin',
  'pincode',
  'pkcs8',
  'private_key',
  'publickey',
  'pwd',
  'recaptcha_key',
  'refresh_token',
  'routingnumber',
  'salt',
  'secret',
  'secretKey',
  'secrettoken',
  'securitycode',
  'security_answer',
  'security_question',
  'serviceaccountcredentials',
  'session',
  'sessionid',
  'sessionkey',
  'set_cookie',
  'signature',
  'signaturekey',
  'ssh_key',
  'ssn',
  'symfony',
  'token',
  'transactionid',
  'twilio_token',
  'user_session',
  'voterid',
  'x-auth-token',
  'x_api_key',
  'x_csrftoken',
  'x_forwarded_for',
  'x_real_ip',
  'XSRF-TOKEN',
]

module.exports = {
  createIsRedactedIdentifier,
  REDACTED_PLACEHOLDER,
}

/**
 * Create a predicate for whether the value of an identifier must be redacted, based on the default list of redacted
 * identifiers and the user's configuration.
 *
 * @param {object} config - The `dynamicInstrumentation` config.
 * @param {string[]} config.DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS - Identifiers to redact in addition to the
 *   defaults.
 * @param {string[]} config.DD_DYNAMIC_INSTRUMENTATION_REDACTION_EXCLUDED_IDENTIFIERS - Identifiers to never redact.
 * @returns {(name: string, isSymbol?: boolean) => boolean} Whether the identifier must be redacted. If `isSymbol` is
 *   `true`, `name` is a `Symbol(...)` description.
 */
function createIsRedactedIdentifier ({
  DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS: redactedIdentifiers,
  DD_DYNAMIC_INSTRUMENTATION_REDACTION_EXCLUDED_IDENTIFIERS: excludedIdentifiers,
}) {
  const excluded = new Set(excludedIdentifiers.map((name) => normalizeName(name)))
  const redacted = new Set()
  for (const name of [...DEFAULT_REDACTED_IDENTIFIERS, ...redactedIdentifiers]) {
    const normalized = normalizeName(name)
    if (!excluded.has(normalized)) redacted.add(normalized)
  }

  return function isRedactedIdentifier (name, isSymbol) {
    return redacted.has(normalizeName(name, isSymbol))
  }
}

/**
 * @param {string} name - The identifier name.
 * @param {boolean} [isSymbol] - Whether the name is a `Symbol(...)` description.
 */
function normalizeName (name, isSymbol) {
  if (isSymbol) name = name.slice(7, -1) // Remove `Symbol(` and `)`
  return name.toLowerCase().replaceAll(/[-_@$.]/g, '')
}
