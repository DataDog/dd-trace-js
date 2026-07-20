'use strict'

const assert = require('node:assert/strict')

const {
  sanitizeConsoleText,
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

  it('preserves name-only GitHub Actions secret references while redacting actual values', () => {
    const reference = 'DD_API_KEY: $' + '{{ secrets.DD_API_KEY }}'

    assert.strictEqual(
      sanitizeString(reference),
      reference
    )
    assert.strictEqual(sanitizeString('DD_API_KEY=actual-value'), 'DD_API_KEY=<redacted>')
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

  it('does not treat natural-language pass labels as secret headers', () => {
    const input = 'Skipped because basic reporting did not pass: The selected command ran tests.'

    assert.strictEqual(sanitizeString(input), input)
  })

  it('preserves JSON structure when redacting bearer values', () => {
    const output = sanitizeString('{"Authorization": "Bearer secret-token"}')

    assert.strictEqual(output, '{"Authorization": "Bearer <redacted>"}')
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

  it('does not consume consecutive secret flags as each other values', () => {
    const report = sanitizeForReport({
      argv: ['node', '--api-key', '--token', 'actual-token-value'],
    })

    assert.deepStrictEqual(report.argv, [
      'node',
      '--api-key',
      '--token',
      '<redacted>',
    ])
  })

  it('redacts common unlabeled token and private-key forms', () => {
    const githubToken = `ghp_${'a'.repeat(24)}`
    const jwt = `eyJ${'a'.repeat(12)}.${'b'.repeat(16)}.${'c'.repeat(16)}`
    const privateKey = [
      '-----BEGIN PRIVATE KEY-----',
      'synthetic-private-key-material',
      '-----END PRIVATE KEY-----',
    ].join('\n')
    const output = sanitizeString(`${githubToken}\n${jwt}\n${privateKey}`)

    assert.doesNotMatch(output, new RegExp(githubToken))
    assert.doesNotMatch(output, new RegExp(jwt.replaceAll('.', '\\.')))
    assert.doesNotMatch(output, /synthetic-private-key-material/)
    assert.match(output, /<redacted>/)
    assert.match(output, /<redacted-private-key>/)
  })

  it('redacts PAT and JWT aliases and all URL userinfo', () => {
    const report = sanitizeForReport({
      GITHUB_PAT: 'github-pat-secret',
      CI_JOB_JWT: 'job-jwt-secret',
      remote: 'https://username-only-secret@example.com/repository.git',
    })

    assert.strictEqual(report.GITHUB_PAT, '<redacted>')
    assert.strictEqual(report.CI_JOB_JWT, '<redacted>')
    assert.strictEqual(report.remote, 'https://<redacted>@example.com/repository.git')
  })

  it('bounds deeply nested untrusted report data', () => {
    const input = {}
    let current = input
    for (let index = 0; index < 1000; index++) {
      current.child = {}
      current = current.child
    }

    const report = sanitizeForReport(input)
    JSON.stringify(report)
    assert.match(JSON.stringify(report), /Truncated: nesting exceeds redaction limit/)
  })

  it('redacts secret names split by default-ignorable Unicode characters', () => {
    const output = sanitizeString(
      'AUTHORIZATION=Bearer top-secret-value npm test\nAPI_KEY\uFE0F=second-secret\n' +
      'API_\u001BKEY=third-secret\nname=before\u202Ehidden'
    )

    assert.strictEqual(
      output,
      'AUTHORIZATION=<redacted> npm test\nAPI_KEY=<redacted>\nAPI_KEY=<redacted>\nname=beforehidden'
    )
    assert.doesNotMatch(output, /top-secret-value/)
    assert.doesNotMatch(output, /second-secret/)
    assert.doesNotMatch(output, /third-secret/)
  })

  it('renders terminal controls inert while preserving line breaks', () => {
    assert.strictEqual(
      sanitizeConsoleText('before\u001b[2Jafter\rbidi\u202Ehidden\nnext'),
      'before[2Jafter\\u000dbidihidden\nnext'
    )
  })
})
