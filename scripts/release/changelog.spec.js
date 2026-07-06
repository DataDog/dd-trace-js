'use strict'

const assert = require('node:assert/strict')

const { createReleaseChangelog } = require('./changelog')

const prLink = (number) => `[#${number}](https://github.com/DataDog/dd-trace-js/pull/${number})`
const avatar = (login) => `[<img src="https://github.com/${login}.png?size=48" width="24" height="24" ` +
  `alt="@${login}" title="@${login}" />](https://github.com/${login})`

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
      '### Features',
      '- **AppSec:** Add AppSec integrations to Laminas Framework ' +
        `(http.route, endpoint collection, login events) ${prLink(3716)}`,
      `- **General:** Add Node.js 26 support ${prLink(8429)}`,
      `- **LLM Observability:** Support Bedrock Converse and ConverseStream ${prLink(8079)}`,
      `- **OpenTelemetry:** Add support for OTLP Runtime Metrics ${prLink(8357)}`,
      '',
      '### Fixes',
      '- **AppSec:** Avoid the possibility of sensitive data going to the telemetry logs backend ' +
        `via WAF strings ${prLink(3884)}`,
      '- **AppSec:** Treat cleared shared memory as no-config rather than an error in AppSec helper ' +
        `${prLink(3876)}`,
      `- **General:** Encoder JSON number type fix ${prLink(38_799)}`,
      '- **LLM Observability:** Revert "Fan array-valued user tags out into one wire entry per element ' +
        `(${prLink(8689)})" ${prLink(8790)}`,
      '- **Profiling:** Prevent panics in profiling encoding under out-of-memory and out-of-bounds ' +
        `conditions ${prLink(3888)}`,
      `- **unknown-scope:** Handle strange thing ${prLink(9999)}`,
      '',
      '### Performance',
      `- **General:** Reduce per-span format and encode overhead ${prLink(8754)}`,
      '',
      '### Documentation',
      `- **General:** Note that startSpan does not activate the returned span ${prLink(8771)}`,
      '',
      '### Internal (CI, Testing, Benchmarking)',
      `- **LLM Observability:** Add the startup guard to the writer encode loop ${prLink(8755)}`,
      `- Fixes APMS-19181: sets the service discovery logs to respect the log level ${prLink(8677)}`,
      `- **release:** Cap proposal at 100 commits and notify guild at 50 ${prLink(8711)}`,
      '',
    ].join('\n'))
    assert.deepStrictEqual(changelog.warnings, [
      'Non-conventional release-note subject for abc016: ' +
        'Fixes APMS-19181: sets the service discovery logs to respect the log level (#8677)',
    ])
  })

  it('does not promote the release to minor when a feature is reverted', () => {
    const changelog = createReleaseChangelog([
      {
        sha: 'abc001',
        subject: 'revert: feat(appsec): add experimental detection (#8689) (#8790)',
      },
      {
        sha: 'abc002',
        subject: 'fix(profiling): correct sample counts (#8791)',
      },
    ])

    assert.strictEqual(changelog.isMinor, false)
    assert.strictEqual(changelog.markdown, [
      '### Features',
      `- **AppSec:** Revert "Add experimental detection (${prLink(8689)})" ${prLink(8790)}`,
      '',
      '### Fixes',
      `- **Profiling:** Correct sample counts ${prLink(8791)}`,
      '',
    ].join('\n'))
  })

  it('renders breaking changes at the top of the release changelog', () => {
    const changelog = createReleaseChangelog([
      {
        sha: 'abc001',
        subject: 'fix(core): keep existing behavior stable (#9001)',
        author: '@alice',
      },
    ], [
      {
        sha: 'abc002',
        subject: 'feat(opentelemetry)!: remove legacy propagation mode (#9002)',
        author: '@bob',
      },
      {
        sha: 'abc003',
        subject: 'chore(deps-dev): bump eslint from 9.0.0 to 10.0.0 (#9003)',
      },
    ])

    assert.strictEqual(changelog.markdown, [
      '### Breaking Changes',
      `- **Dependencies:** Bump eslint from 9.0.0 to 10.0.0 ${prLink(9003)}`,
      `- **OpenTelemetry:** Remove legacy propagation mode ${prLink(9002)}`,
      '',
      '### Fixes',
      `- **General:** Keep existing behavior stable ${prLink(9001)}`,
      '',
      '### Contributors',
      '',
      `${avatar('alice')} ${avatar('bob')}`,
      '',
    ].join('\n'))
  })

  it('does not promote the release to minor for breaking-only features', () => {
    const changelog = createReleaseChangelog([
      {
        sha: 'abc001',
        subject: 'fix(core): keep existing behavior stable (#9001)',
      },
    ], [
      {
        sha: 'abc002',
        subject: 'feat(opentelemetry)!: remove legacy propagation mode (#9002)',
      },
    ])

    assert.strictEqual(changelog.isMinor, false)
  })

  it('drops regular release note entries already listed as breaking changes', () => {
    const changelog = createReleaseChangelog([
      {
        sha: 'abc001',
        subject: 'feat(opentelemetry)!: remove legacy propagation mode (#9002)',
      },
      {
        sha: 'abc002',
        subject: 'fix(core): keep existing behavior stable (#9001)',
      },
    ], [
      {
        sha: 'abc003',
        subject: 'feat(opentelemetry)!: remove legacy propagation mode (#9002)',
      },
    ])

    assert.strictEqual(changelog.markdown, [
      '### Breaking Changes',
      `- **OpenTelemetry:** Remove legacy propagation mode ${prLink(9002)}`,
      '',
      '### Fixes',
      `- **General:** Keep existing behavior stable ${prLink(9001)}`,
      '',
    ].join('\n'))
    assert.strictEqual(changelog.isMinor, false)
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
      '### Features',
      '- **OpenTelemetry:** Add breaking OpenTelemetry behavior',
      '',
      '### Fixes',
      '- **General:** Keep request tagging stable',
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
      '### Fixes',
      `- **AppSec:** Trim empty scope segments ${prLink(1234)}`,
      '',
    ].join('\n'))
  })

  it('labels an unmapped scope with the scope from the commit and does not warn', () => {
    const changelog = createReleaseChangelog([
      { sha: 'abc001', subject: 'feat(aws-sdk): create SQS consumer spans (#8827)' },
      { sha: 'abc002', subject: 'fix(redis): drop db.name placeholder (#8402)' },
    ])

    assert.strictEqual(changelog.markdown, [
      '### Features',
      `- **aws-sdk:** Create SQS consumer spans ${prLink(8827)}`,
      '',
      '### Fixes',
      `- **redis:** Drop db.name placeholder ${prLink(8402)}`,
      '',
    ].join('\n'))
    assert.deepStrictEqual(changelog.warnings, [])
  })

  it('renders the full scope list when no scope maps to a product', () => {
    const changelog = createReleaseChangelog([
      { sha: 'abc001', subject: 'fix(redis, iovalkey): align reconnect handling (#8001)' },
    ])

    assert.strictEqual(changelog.markdown, [
      '### Fixes',
      `- **redis, iovalkey:** Align reconnect handling ${prLink(8001)}`,
      '',
    ].join('\n'))
  })

  it('maps newly recognized scopes to their products', () => {
    const changelog = createReleaseChangelog([
      { sha: 'abc001', subject: 'fix(aap): block on suspicious request (#9001)' },
      { sha: 'abc002', subject: 'fix(ai_guard): tighten prompt evaluation (#9002)' },
      { sha: 'abc003', subject: 'fix(dsm): track message lineage (#9003)' },
      { sha: 'abc004', subject: 'fix(dbm): propagate trace context to SQL comments (#9004)' },
      { sha: 'abc005', subject: 'fix(exporters): route agentless spans to the regional intake (#9005)' },
      { sha: 'abc006', subject: 'fix(openfeature): record exposure events (#9006)' },
      { sha: 'abc007', subject: 'fix(test-optimization): dedupe known tests (#9007)' },
      { sha: 'abc008', subject: 'fix(jest): stabilize worker handoff (#9008)' },
    ])

    assert.strictEqual(changelog.markdown, [
      '### Fixes',
      `- **AI Guard:** Tighten prompt evaluation ${prLink(9002)}`,
      `- **AppSec:** Block on suspicious request ${prLink(9001)}`,
      `- **Data Streams Monitoring:** Track message lineage ${prLink(9003)}`,
      `- **Database Monitoring:** Propagate trace context to SQL comments ${prLink(9004)}`,
      `- **Feature Flags:** Record exposure events ${prLink(9006)}`,
      `- **General:** Route agentless spans to the regional intake ${prLink(9005)}`,
      `- **Test Optimization:** Dedupe known tests ${prLink(9007)}`,
      `- **Test Optimization:** Stabilize worker handoff ${prLink(9008)}`,
      '',
    ].join('\n'))
    assert.deepStrictEqual(changelog.warnings, [])
  })

  it('keeps production dependency bumps and drops development and instrumented ones', () => {
    const changelog = createReleaseChangelog([
      { sha: 'abc001', subject: 'chore(deps): bump form-data from 4.0.5 to 4.0.6 (#8918)' },
      {
        sha: 'abc002',
        subject: 'chore(deps): bump protobufjs from 8.4.2 to 8.6.0 in /vendor in the ' +
          'vendor-minor-and-patch-dependencies group across 1 directory (#8851)',
      },
      {
        sha: 'abc003',
        subject: 'chore(deps): bump the runtime-minor-and-patch-dependencies group across 1 directory ' +
          'with 3 updates (#8920)',
      },
      {
        sha: 'abc004',
        subject: 'chore(deps-dev): bump the dev-minor-and-patch-dependencies group across 1 directory ' +
          'with 4 updates (#8854)',
      },
      {
        sha: 'abc005',
        subject: 'chore(deps): bump @anthropic-ai/sdk from 0.101.0 to 0.102.0 in ' +
          '/packages/dd-trace/test/plugins/versions in the ai-and-llm group across 1 directory (#8852)',
      },
      { sha: 'abc006', subject: 'chore(deps): bump the serverless group across 1 directory with 8 updates (#8929)' },
      { sha: 'abc007', subject: 'chore(deps): bump markdown-it from 14.1.1 to 14.2.0 in /docs (#8932)' },
    ])

    assert.strictEqual(changelog.markdown, [
      '### Internal (CI, Testing, Benchmarking)',
      `- **Dependencies:** Bump form-data from 4.0.5 to 4.0.6 ${prLink(8918)}`,
      '- **Dependencies:** Bump protobufjs from 8.4.2 to 8.6.0 in /vendor in the ' +
        `vendor-minor-and-patch-dependencies group across 1 directory ${prLink(8851)}`,
      '- **Dependencies:** Bump the runtime-minor-and-patch-dependencies group across 1 directory ' +
        `with 3 updates ${prLink(8920)}`,
      '',
    ].join('\n'))
  })

  it('renders pull request references as explicit links to keep GitHub from expanding them', () => {
    const changelog = createReleaseChangelog([
      { sha: 'abc001', subject: 'fix(redis): drop placeholder (#8402)' },
    ])

    assert.ok(changelog.markdown.includes('[#8402](https://github.com/DataDog/dd-trace-js/pull/8402)'))
  })

  it('links inline pull request references inside a subject', () => {
    const changelog = createReleaseChangelog([
      { sha: 'abc001', subject: 'revert: fix(core): undo change (#8689) (#8790)' },
    ])

    assert.ok(changelog.markdown.includes(
      'Revert "Undo change ([#8689](https://github.com/DataDog/dd-trace-js/pull/8689))" ' +
      '[#8790](https://github.com/DataDog/dd-trace-js/pull/8790)'
    ))
  })

  it('renders contributor avatars on a single line and leaves non-handle names as text', () => {
    const changelog = createReleaseChangelog([
      { sha: 'abc001', subject: 'feat(appsec): add thing (#1)', author: '@Zoe' },
      { sha: 'abc002', subject: 'fix(profiling): fix thing (#2)', author: '@alice' },
      { sha: 'abc003', subject: 'ci(release): tweak the workflow (#3)', author: '@Zoe' },
      { sha: 'abc004', subject: 'fix(core): another thing (#4)', author: 'Jane Doe' },
    ])

    assert.strictEqual(changelog.markdown, [
      '### Features',
      `- **AppSec:** Add thing ${prLink(1)}`,
      '',
      '### Fixes',
      `- **General:** Another thing ${prLink(4)}`,
      `- **Profiling:** Fix thing ${prLink(2)}`,
      '',
      '### Internal (CI, Testing, Benchmarking)',
      `- **release:** Tweak the workflow ${prLink(3)}`,
      '',
      '### Contributors',
      '',
      `${avatar('alice')} ${avatar('Zoe')} Jane Doe`,
      '',
    ].join('\n'))
  })

  it('omits the Contributors section when no entry carries an author', () => {
    const changelog = createReleaseChangelog([
      { sha: 'abc001', subject: 'fix(appsec): handle thing (#1)' },
    ])

    assert.strictEqual(changelog.markdown, [
      '### Fixes',
      `- **AppSec:** Handle thing ${prLink(1)}`,
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
      '### Internal (CI, Testing, Benchmarking)',
      `- deps(express): bump express ${prLink(1234)}`,
      '',
    ].join('\n'))
    assert.deepStrictEqual(changelog.warnings, [
      'Non-conventional release-note subject for abc001: deps(express): bump express (#1234)',
    ])
  })
})
