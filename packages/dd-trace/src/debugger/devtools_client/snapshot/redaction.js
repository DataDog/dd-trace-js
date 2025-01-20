'use strict'

const config = require('../config')

const excludedIdentifiers = config.dynamicInstrumentation.redactionExcludedIdentifiers
  .map((name) => normalizeName(name))

const REDACTED_IDENTIFIERS = new Set(
  [
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
    ...config.dynamicInstrumentation.redactedIdentifiers
  ]
    .map((name) => normalizeName(name))
    .filter((name) => excludedIdentifiers.includes(name) === false)
)

function normalizeName (name, isSymbol) {
  if (isSymbol) name = name.slice(7, -1) // Remove `Symbol(` and `)`
  return name.toLowerCase().replace(/[-_@$.]/g, '')
}

module.exports = {
  REDACTED_IDENTIFIERS,
  normalizeName
}
