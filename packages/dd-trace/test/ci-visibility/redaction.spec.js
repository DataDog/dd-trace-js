'use strict'

const assert = require('node:assert/strict')

const {
  sanitizeForReport,
  sanitizeString,
} = require('../../../../ci/test-optimization-validation/redaction')

describe('test optimization validation redaction', () => {
  it('redacts exact inline secret assignments', () => {
    const input = [
      'API_KEY=api-key-secret',
      'APP_KEY=app-key-secret',
      'TOKEN=token-secret',
      'SECRET=secret-secret',
      'PASSWORD=password-secret',
      'PASSPHRASE=passphrase-secret',
      'CREDENTIAL=credential-secret',
      'PRIVATE_KEY=private-key-secret',
      'CLIENT_SECRET=client-secret-secret',
      'ACCESS_KEY=access-key-secret',
      'COOKIE=cookie-secret',
      'AUTH=auth-secret',
      'AUTHORIZATION=authorization-secret',
      'PASS=pass-secret',
    ].join(' ')

    const output = sanitizeString(input)

    assert.match(output, /API_KEY=<redacted>/)
    assert.match(output, /APP_KEY=<redacted>/)
    assert.match(output, /TOKEN=<redacted>/)
    assert.match(output, /SECRET=<redacted>/)
    assert.match(output, /PASSWORD=<redacted>/)
    assert.match(output, /PASSPHRASE=<redacted>/)
    assert.match(output, /CREDENTIAL=<redacted>/)
    assert.match(output, /PRIVATE_KEY=<redacted>/)
    assert.match(output, /CLIENT_SECRET=<redacted>/)
    assert.match(output, /ACCESS_KEY=<redacted>/)
    assert.match(output, /COOKIE=<redacted>/)
    assert.match(output, /AUTH=<redacted>/)
    assert.match(output, /AUTHORIZATION=<redacted>/)
    assert.match(output, /PASS=<redacted>/)

    for (const secret of [
      'api-key-secret',
      'app-key-secret',
      'token-secret',
      'secret-secret',
      'password-secret',
      'passphrase-secret',
      'credential-secret',
      'private-key-secret',
      'client-secret-secret',
      'access-key-secret',
      'cookie-secret',
      'auth-secret',
      'authorization-secret',
      'pass-secret',
    ]) {
      assert.doesNotMatch(output, new RegExp(secret))
    }
  })

  it('preserves name-only secret environment variable lists', () => {
    const report = sanitizeForReport({
      requiredSecretEnvVars: ['API_KEY', 'TOKEN', 'SECRET'],
      secretEnvVars: ['PASSWORD', 'PRIVATE_KEY'],
      missingEnvVars: ['APP_KEY'],
      regularCommand: 'API_KEY=api-key-secret npm test',
    })

    assert.deepStrictEqual(report.requiredSecretEnvVars, ['API_KEY', 'TOKEN', 'SECRET'])
    assert.deepStrictEqual(report.secretEnvVars, ['PASSWORD', 'PRIVATE_KEY'])
    assert.deepStrictEqual(report.missingEnvVars, ['APP_KEY'])
    assert.strictEqual(report.regularCommand, 'API_KEY=<redacted> npm test')
  })

  it('redacts colon-form secret environment output', () => {
    const output = sanitizeString([
      'DD_API_KEY: dd-api-key-colon-secret',
      'API_KEY: api-key-colon-secret',
      'PASSWORD: password-colon-secret',
      'authorization: Bearer authorization-colon-secret',
    ].join('\n'))

    assert.match(output, /DD_API_KEY: <redacted>/)
    assert.match(output, /API_KEY: <redacted>/)
    assert.match(output, /PASSWORD: <redacted>/)
    assert.match(output, /authorization: <redacted>/)
    assert.doesNotMatch(output, /dd-api-key-colon-secret/)
    assert.doesNotMatch(output, /api-key-colon-secret/)
    assert.doesNotMatch(output, /password-colon-secret/)
    assert.doesNotMatch(output, /authorization-colon-secret/)
  })

  it('redacts split secret flag values in arrays', () => {
    const report = sanitizeForReport({
      argv: ['node', 'test.js', '--api-key', 'api-key-secret', '--token', 'token-secret', '--safe', 'visible'],
      nested: {
        processArgv: ['vitest', '--client-secret', 'client-secret-value'],
      },
    })

    assert.deepStrictEqual(report.argv, [
      'node',
      'test.js',
      '--api-key',
      '<redacted>',
      '--token',
      '<redacted>',
      '--safe',
      'visible',
    ])
    assert.deepStrictEqual(report.nested.processArgv, [
      'vitest',
      '--client-secret',
      '<redacted>',
    ])
  })
})
