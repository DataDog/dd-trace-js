'use strict'

const assert = require('node:assert/strict')

const { createReleaseChangelog } = require('./changelog')

describe('release changelog', () => {
  it('renders conventional commits in the release changelog format', () => {
    const entries = [
      {
        sha: 'abc001',
        subject: 'feat(appsec): add AppSec integrations to Laminas Framework ' +
          '(http.route, endpoint collection, login events) (#3716)',
      },
      {
        sha: 'abc002',
        subject: 'fix(appsec): treat cleared shared memory as no-config rather than an error in AppSec helper (#3876)',
      },
      {
        sha: 'abc003',
        subject: 'fix(appsec): avoid the possibility of sensitive data going to the telemetry logs backend ' +
          'via WAF strings (#3884)',
      },
      {
        sha: 'abc004',
        subject: 'fix: encoder JSON number type fix (#38799)',
      },
      {
        sha: 'abc005',
        subject: 'fix(profiling): prevent panics in profiling encoding under out-of-memory and out-of-bounds ' +
          'conditions (#3888)',
      },
      {
        sha: 'abc006',
        subject: 'perf(format,encode): reduce per-span format and encode overhead (#8754)',
      },
      {
        sha: 'abc007',
        subject: 'docs(types): note that startSpan does not activate the returned span (#8771)',
      },
      {
        sha: 'abc008',
        subject: 'feat(otel): add support for OTLP Runtime Metrics (#8357)',
      },
      {
        sha: 'abc009',
        subject: 'chore(deps): bump the serverless group across 1 directory with 8 updates (#8782)',
      },
      {
        sha: 'abc010',
        subject: 'ci(release): cap proposal at 100 commits and notify guild at 50 (#8711)',
      },
      {
        sha: 'abc011',
        subject: 'bench(llmobs): add the startup guard to the writer encode loop (#8755)',
      },
      {
        sha: 'abc012',
        subject: 'revert: fix(llmobs): fan array-valued user tags out into one wire entry per element (#8689) (#8790)',
      },
      {
        sha: 'abc013',
        subject: 'feat(aws-sdk, llmobs): support Bedrock Converse and ConverseStream (#8079)',
      },
      {
        sha: 'abc014',
        subject: 'feat: add Node.js 26 support (#8429)',
      },
      {
        sha: 'abc015',
        subject: 'fix(unknown-scope): handle strange thing (#9999)',
      },
      {
        sha: 'abc016',
        subject: 'Fixes APMS-19181: sets the service discovery logs to respect the log level (#8677)',
      },
    ]

    const changelog = createReleaseChangelog(entries)

    assert.strictEqual(changelog.isMinor, true)
    assert.strictEqual(changelog.markdown, [
      'Features',
      '- <b>AppSec</b> Add AppSec integrations to Laminas Framework ' +
        '(http.route, endpoint collection, login events) #3716',
      '- <b>OpenTelemetry</b> Add support for OTLP Runtime Metrics #8357',
      '- <b>LLMObs</b> Support Bedrock Converse and ConverseStream #8079',
      '- <b>General</b> Add Node.js 26 support #8429',
      '',
      'Fixes',
      '- <b>AppSec</b> Treat cleared shared memory as no-config rather than an error in AppSec helper #3876',
      '- <b>AppSec</b> Avoid the possibility of sensitive data going to the telemetry logs backend ' +
        'via WAF strings #3884',
      '- <b>General</b> Encoder JSON number type fix #38799',
      '- <b>Profiling</b> Prevent panics in profiling encoding under out-of-memory and out-of-bounds ' +
        'conditions #3888',
      '- <b>LLMObs</b> Revert "Fan array-valued user tags out into one wire entry per element (#8689)" #8790',
      '- <b>Other</b> Handle strange thing #9999',
      '',
      'Performance',
      '- <b>General</b> Reduce per-span format and encode overhead #8754',
      '',
      'Documentation',
      '- <b>General</b> Note that startSpan does not activate the returned span #8771',
      '',
      '<b>Internal</b> (CI, Testing, Benchmarking)',
      '- Bump the serverless group across 1 directory with 8 updates #8782',
      '- Cap proposal at 100 commits and notify guild at 50 #8711',
      '- Add the startup guard to the writer encode loop #8755',
      '- Fixes APMS-19181: sets the service discovery logs to respect the log level #8677',
      '',
    ].join('\n'))
    assert.deepStrictEqual(changelog.warnings, [
      'Unknown release-note product for abc015: fix(unknown-scope): handle strange thing (#9999)',
      'Non-conventional release-note subject for abc016: ' +
        'Fixes APMS-19181: sets the service discovery logs to respect the log level (#8677)',
    ])
  })

  it('handles breaking markers and subjects without pull request numbers', () => {
    const changelog = createReleaseChangelog([
      {
        sha: 'abc001',
        subject: 'feat(opentelemetry)!: add breaking OpenTelemetry behavior',
      },
      {
        sha: 'abc002',
        subject: 'fix(http/http2): keep request tagging stable',
      },
    ])

    assert.strictEqual(changelog.markdown, [
      'Features',
      '- <b>OpenTelemetry</b> Add breaking OpenTelemetry behavior',
      '',
      'Fixes',
      '- <b>General</b> Keep request tagging stable',
      '',
    ].join('\n'))
  })

  it('ignores empty scopes in multi-scope subjects', () => {
    const changelog = createReleaseChangelog([
      {
        sha: 'abc001',
        subject: 'fix( , appsec): trim empty scope segments (#1234)',
      },
    ])

    assert.strictEqual(changelog.markdown, [
      'Fixes',
      '- <b>AppSec</b> Trim empty scope segments #1234',
      '',
    ].join('\n'))
  })

  it('lists unique contributors sorted case-insensitively after the change sections', () => {
    const changelog = createReleaseChangelog([
      { sha: 'abc001', subject: 'feat(appsec): add thing (#1)', author: '@Zoe' },
      { sha: 'abc002', subject: 'fix(profiling): fix thing (#2)', author: '@alice' },
      { sha: 'abc003', subject: 'ci(release): tweak the workflow (#3)', author: '@Zoe' },
    ])

    assert.strictEqual(changelog.markdown, [
      'Features',
      '- <b>AppSec</b> Add thing #1',
      '',
      'Fixes',
      '- <b>Profiling</b> Fix thing #2',
      '',
      '<b>Internal</b> (CI, Testing, Benchmarking)',
      '- Tweak the workflow #3',
      '',
      'Contributors',
      '- @alice',
      '- @Zoe',
      '',
    ].join('\n'))
  })

  it('omits the Contributors section when no entry carries an author', () => {
    const changelog = createReleaseChangelog([
      { sha: 'abc001', subject: 'fix(appsec): handle thing (#1)' },
    ])

    assert.strictEqual(changelog.markdown, [
      'Fixes',
      '- <b>AppSec</b> Handle thing #1',
      '',
    ].join('\n'))
  })

  it('treats unsupported conventional types as non-conventional', () => {
    const changelog = createReleaseChangelog([
      {
        sha: 'abc001',
        subject: 'deps(express): bump express (#1234)',
      },
    ])

    assert.strictEqual(changelog.markdown, [
      '<b>Internal</b> (CI, Testing, Benchmarking)',
      '- deps(express): bump express #1234',
      '',
    ].join('\n'))
    assert.deepStrictEqual(changelog.warnings, [
      'Non-conventional release-note subject for abc001: deps(express): bump express (#1234)',
    ])
  })
})
