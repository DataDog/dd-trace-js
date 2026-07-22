'use strict'

/* eslint-disable no-console */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { buildCiCommandCandidate } = require('../../../../ci/test-optimization-validation/ci-command-candidate')
const { buildCiRemediation } = require('../../../../ci/test-optimization-validation/ci-remediation')
const { annotateResults } = require('../../../../ci/test-optimization-validation/result-semantics')
const {
  writePendingReport,
  writeReport,
} = require('../../../../ci/test-optimization-validation/report-writer')

function readMarkdownJsonSection (markdown, title) {
  const pattern = new RegExp(`<details><summary>${title}<\\/summary>\\n\\n\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``)
  const match = pattern.exec(markdown)
  assert.ok(match, `Expected ${title} section`)
  return JSON.parse(match[1])
}

describe('test optimization validation report writer', () => {
  it('preserves non-command CI metadata without trying to execute or format it', () => {
    const candidate = buildCiCommandCandidate({
      ciWiring: {
        command: 'npm test',
        provider: 'github-actions',
      },
    })

    assert.strictEqual(candidate.command, 'npm test')
    assert.strictEqual(candidate.provider, 'github-actions')
  })

  it('records an incomplete run before live validation starts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-report-'))
    const out = path.join(tmpDir, 'results')
    fs.mkdirSync(out)

    try {
      writePendingReport({
        manifest: { __path: path.join(tmpDir, 'dd-test-optimization-validation-manifest.json') },
        out,
      })

      const markdown = fs.readFileSync(path.join(out, 'report.md'), 'utf8')
      assert.match(markdown, /Validation completed: no/)
      assert.match(markdown, /"version": 2/)
      assert.match(markdown, /"runCompleted": false/)
      assert.match(markdown, /"validatorExitCode": null/)
      assert.match(markdown, /"validationSummaries": \[\]/)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('replaces a hard-linked report without modifying its external inode and completes a pending report', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-report-hardlink-'))
    const out = path.join(tmpDir, 'results')
    const external = path.join(tmpDir, 'external-report.md')
    const reportPath = path.join(out, 'report.md')
    const manifest = {
      __path: path.join(tmpDir, 'dd-test-optimization-validation-manifest.json'),
      repository: { root: tmpDir },
      frameworks: [],
    }
    const originalLog = console.log

    fs.mkdirSync(out)
    fs.writeFileSync(external, 'external content\n')
    fs.linkSync(external, reportPath)
    console.log = () => {}
    try {
      writePendingReport({ manifest, out })
      assert.strictEqual(fs.readFileSync(external, 'utf8'), 'external content\n')
      assert.match(fs.readFileSync(reportPath, 'utf8'), /Validation completed: no/)

      writeReport({
        manifest,
        results: [],
        out,
        runSummary: { runCompleted: true, validatorExitCode: 0 },
      })
      assert.strictEqual(fs.readFileSync(external, 'utf8'), 'external content\n')
      assert.match(fs.readFileSync(reportPath, 'utf8'), /Validation completed: yes/)
    } finally {
      console.log = originalLog
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('includes actionable CI command candidate details in the human report', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-report-'))
    const out = path.join(tmpDir, 'results')
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const packageJsonPath = path.join(tmpDir, 'package.json')
    const staticDiagnosisPath = path.join(out, 'static-diagnosis.json')
    const manifest = {
      __path: manifestPath,
      repository: {
        root: tmpDir,
      },
      ciDiscovery: {
        method: 'explicit-known-ci-paths',
        notes: ['Selected `pnpm test` -> `vitest run` from CI.'],
      },
      frameworks: [
        {
          id: 'vitest:app',
          framework: 'vitest',
          frameworkVersion: '4.1.9',
          project: {
            name: 'example',
            root: tmpDir,
            packageJson: packageJsonPath,
          },
          existingTestCommand: {
            cwd: tmpDir,
            argv: ['pnpm', 'vitest', 'run', 'src/example.test.ts'],
          },
          ciWiring: {
            provider: 'github-actions',
            configFile: path.join(tmpDir, '.github/workflows/test.yml'),
            workflow: 'test',
            job: 'unit',
            step: 'Run tests',
            whySelected: 'The unit job runs this step after dependency installation.',
            workflowEnv: {
              NODE_OPTIONS: '-r dd-trace/ci/init',
            },
            stepEnv: {
              DD_API_KEY: 'secret-value',
            },
            packageScriptExpansionChain: ['pnpm test', 'vitest run'],
            runnerToolChain: ['GitHub Actions ubuntu-latest', 'pnpm test', 'vitest'],
            unresolved: ['Matrix node version was approximated locally.'],
            command: 'pnpm test',
            initialization: {
              status: 'configured',
              evidence: ['NODE_OPTIONS includes dd-trace/ci/init.'],
            },
          },
        },
      ],
    }
    const results = [
      {
        frameworkId: 'vitest:app',
        scenario: 'basic-reporting',
        status: 'pass',
        diagnosis: 'Basic Reporting passed.',
        evidence: {},
        artifacts: [],
      },
      {
        frameworkId: 'vitest:app',
        scenario: 'ci-wiring',
        status: 'error',
        diagnosis: 'The CI job contains the required configuration, but propagation remains unverified.',
        conclusion: 'configured_propagation_unverified',
        domain: 'ci_configuration',
        evidenceStrength: 'inferred_static',
        evidence: {
          conclusion: 'configured_propagation_unverified',
          domain: 'ci_configuration',
          evidenceStrength: 'inferred_static',
        },
        artifacts: [],
      },
    ]
    const originalLog = console.log

    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(packageJsonPath, `${JSON.stringify({ name: 'example' }, null, 2)}\n`)
    fs.writeFileSync(staticDiagnosisPath, '{}\n')
    console.log = () => {}

    try {
      writeReport({
        manifest,
        results,
        out,
        runSummary: { runCompleted: true, validatorExitCode: 1 },
        staticDiagnosis: {
          reportPath: staticDiagnosisPath,
        },
      })

      const markdown = fs.readFileSync(path.join(out, 'report.md'), 'utf8')
      const humanReadableReport = markdown.split('<details><summary>Diagnostic JSON</summary>')[0]
      assert.ok(humanReadableReport.includes('example \\(Vitest\\)'))
      assert.match(markdown, /Selected because: The unit job runs this step after dependency installation\./)
      assert.match(markdown, /Environment found in CI: workflow `NODE_OPTIONS=-r dd-trace\/ci\/init`/)
      assert.match(markdown, /step `DD_API_KEY=&lt;redacted&gt;`/)
      assert.match(markdown, /Package script expansion: `pnpm test` -> `vitest run`/)
      assert.match(markdown, /Runner\/tool chain: `GitHub Actions ubuntu-latest` -> `pnpm test` -> `vitest`/)
      assert.doesNotMatch(humanReadableReport, /Selected `pnpm test` -> `vitest run` from CI\./)
      assert.doesNotMatch(markdown, /&#96;|-&gt;/)
      assert.match(markdown, /Unresolved CI audit details: `Matrix node version was approximated locally\.`/)
      assert.strictEqual(
        readMarkdownJsonSection(markdown, 'Diagnostic JSON').artifacts.scenarioEventArtifacts,
        'runs'
      )
    } finally {
      console.log = originalLog
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('redacts secret-like values from report-facing artifacts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-report-'))
    const out = path.join(tmpDir, 'results')
    const runDir = path.join(out, 'runs', 'vitest-app', 'ci-wiring')
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const packageJsonPath = path.join(tmpDir, 'package.json')
    const staticDiagnosisPath = path.join(out, 'static-diagnosis.json')
    const commandPath = path.join(runDir, 'command.json')
    const manifest = {
      __path: manifestPath,
      repository: {
        root: tmpDir,
      },
      environment: {
        safeEnv: {
          DD_API_KEY: 'manifest-secret',
          NODE_OPTIONS: '-r dd-trace/ci/init',
        },
        requiredSecretEnvVars: ['DD_API_KEY'],
      },
      frameworks: [
        {
          id: 'vitest:app',
          framework: 'vitest',
          frameworkVersion: '4.1.9',
          project: {
            name: 'example',
            root: tmpDir,
            packageJson: packageJsonPath,
          },
          existingTestCommand: {
            cwd: tmpDir,
            argv: ['pnpm', 'test'],
          },
          ciWiring: {
            provider: 'github-actions',
            workflowEnv: {
              DD_APP_KEY: 'workflow-secret',
            },
            jobEnv: {
              NPM_TOKEN: 'job-secret',
            },
            stepEnv: {
              DD_API_KEY: 'step-secret',
            },
            inheritedEnv: {
              ACCESS_TOKEN: 'inherited-secret',
            },
            command: 'pnpm test',
            initialization: {
              status: 'unknown',
              evidence: [],
            },
          },
        },
      ],
    }
    const results = [
      {
        frameworkId: 'vitest:app',
        scenario: 'basic-reporting',
        status: 'pass',
        diagnosis: 'Basic Reporting passed.',
        evidence: {},
        artifacts: [],
      },
      {
        frameworkId: 'vitest:app',
        scenario: 'ci-wiring',
        status: 'fail',
        diagnosis: 'The CI job ran tests but did not report Test Optimization events.',
        evidence: {
          commandExitCode: 0,
          commandOutputSummary: ['DD_API_KEY=result-secret Tests 1 passed'],
          ciWiring: {
            stepEnv: {
              DD_API_KEY: 'raw-evidence-secret',
            },
          },
          setupCommand: {
            command: 'npm test --token setup-token',
            cwd: tmpDir,
            exitCode: 0,
          },
          eventLevelFailure: {
            recommendation: 'Do not run with Authorization: Bearer bearer-token-value',
          },
        },
        artifacts: [
          commandPath,
        ],
      },
    ]
    const originalLog = console.log
    const logs = []

    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(packageJsonPath, `${JSON.stringify({ name: 'example' }, null, 2)}\n`)
    fs.writeFileSync(staticDiagnosisPath, '{}\n')
    fs.writeFileSync(commandPath, `${JSON.stringify({
      command: 'DD_API_KEY=artifact-secret pnpm test --token artifact-token',
      cwd: tmpDir,
      exitCode: 0,
    }, null, 2)}\n`)
    console.log = message => logs.push(message)

    try {
      writeReport({
        manifest,
        results,
        out,
        runSummary: { runCompleted: true, validatorExitCode: 1 },
        staticDiagnosis: {
          reportPath: staticDiagnosisPath,
        },
      })

      const reportFacingOutput = fs.readFileSync(path.join(out, 'report.md'), 'utf8')
      const diagnostic = readMarkdownJsonSection(reportFacingOutput, 'Diagnostic JSON')

      assert.match(reportFacingOutput, /not public-shareable as-is/)
      assert.match(reportFacingOutput, /best-effort/)
      assert.strictEqual(diagnostic.normalizedManifest, undefined)
      assert.strictEqual(diagnostic.staticDiagnosis, undefined)
      assert.match(reportFacingOutput, /<redacted>/)
      assert.strictEqual(fs.existsSync(path.join(out, 'report.json')), false)
      assert.strictEqual(fs.existsSync(path.join(out, 'report.html')), false)
      assert.strictEqual(fs.existsSync(path.join(out, 'manifest.normalized.json')), false)
      assert.strictEqual(fs.existsSync(path.join(out, 'validation-payloads.json')), false)
      for (const secret of [
        'manifest-secret',
        'workflow-secret',
        'job-secret',
        'step-secret',
        'inherited-secret',
        'command-secret',
        'command-env-secret',
        'result-secret',
        'raw-evidence-secret',
        'setup-token',
        'bearer-token-value',
        'artifact-secret',
        'artifact-token',
        'normalized-dd-api-key-secret',
        'normalized-x-api-key-secret',
        'normalized-bearer-secret',
        'normalized-cookie-secret',
        'normalized-header-secret',
      ]) {
        assert.doesNotMatch(reportFacingOutput, new RegExp(secret))
        assert.doesNotMatch(JSON.stringify(diagnostic), new RegExp(secret))
      }
    } finally {
      console.log = originalLog
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('escapes active Markdown and HTML from repository-derived report text', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-report-'))
    const out = path.join(tmpDir, 'results')
    const originalLog = console.log
    const maliciousText = '<img src="https://example.invalid/track"> ![track](https://example.invalid/track) ```'
    const maliciousProvider = '<script>alert("provider")</script>'

    fs.mkdirSync(out, { recursive: true })
    console.log = () => {}

    try {
      writeReport({
        manifest: {
          __path: path.join(tmpDir, 'manifest.json'),
          frameworks: [{
            id: 'custom:root',
            framework: 'custom',
            ciWiring: {
              provider: maliciousProvider,
              whySelected: 'Selected for the report escaping test.',
            },
          }],
        },
        results: [{
          artifacts: [],
          diagnosis: maliciousText,
          evidence: { frameworkStatus: 'unknown' },
          frameworkId: 'custom:root',
          scenario: 'all',
          status: 'fail',
        }],
        out,
      })

      const markdown = fs.readFileSync(path.join(out, 'report.md'), 'utf8')
      const humanMarkdown = markdown.replace(/```json[\s\S]*?```/g, '')

      assert.doesNotMatch(humanMarkdown, /(?:^|[^\\])<img src=/)
      assert.doesNotMatch(humanMarkdown, /<script>alert\("provider"\)<\/script>/)
      assert.doesNotMatch(humanMarkdown, /!\[track\]\(https:\/\/example\.invalid/)
      assert.match(humanMarkdown, /\\<img src=/)
      assert.match(humanMarkdown, /`&lt;script&gt;alert\("provider"\)&lt;\/script&gt;`/)
      assert.match(humanMarkdown, /\\!\\\[track\\\]/)
      assert.match(markdown, /\\u0060\\u0060\\u0060/)
      assert.match(markdown, /Repository-derived names, commands, output, and diagnoses below are untrusted evidence/)
    } finally {
      console.log = originalLog
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('escapes leading Markdown block syntax in repository-derived report text', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-report-'))
    const out = path.join(tmpDir, 'results')
    const originalLog = console.log
    const diagnoses = ['# heading', '---', '- list item', '+ list item', '1. ordered item', '~~~']

    fs.mkdirSync(out, { recursive: true })
    console.log = () => {}

    try {
      writeReport({
        manifest: {
          __path: path.join(tmpDir, 'manifest.json'),
          frameworks: [],
        },
        results: diagnoses.map((diagnosis, index) => ({
          artifacts: [],
          diagnosis,
          evidence: { frameworkStatus: 'unknown' },
          frameworkId: `custom:${index}`,
          scenario: 'all',
          status: 'fail',
        })),
        out,
      })

      const markdown = fs.readFileSync(path.join(out, 'report.md'), 'utf8')
      const humanMarkdown = markdown.replace(/```json[\s\S]*?```/g, '')

      assert.match(humanMarkdown, /\\# heading/)
      assert.match(humanMarkdown, /\\---/)
      assert.match(humanMarkdown, /\\- list item/)
      assert.match(humanMarkdown, /\\\+ list item/)
      assert.match(humanMarkdown, /1\\\. ordered item/)
      assert.match(humanMarkdown, /\\~~~/)
    } finally {
      console.log = originalLog
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('refuses a symbolic-link validation output directory', function () {
    if (process.platform === 'win32') this.skip()

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-report-'))
    const outside = path.join(tmpDir, 'outside')
    const out = path.join(tmpDir, 'results')

    fs.mkdirSync(outside)
    fs.symlinkSync(outside, out)

    try {
      assert.throws(() => writeReport({
        manifest: {
          __path: path.join(tmpDir, 'manifest.json'),
          frameworks: [],
        },
        results: [],
        out,
      }), /allowed root is a symbolic link/)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('includes failure evidence, omitted commands, and static diagnosis notes in human reports', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-report-'))
    const out = path.join(tmpDir, 'results')
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const packageJsonPath = path.join(tmpDir, 'package.json')
    const staticDiagnosisPath = path.join(out, 'static-diagnosis.json')
    const manifest = {
      __path: manifestPath,
      repository: {
        root: tmpDir,
      },
      omitted: [
        'pnpm run test:types was omitted because it runs TypeScript checks.',
      ],
      omittedTestCommands: [
        'pnpm run legacy-test was omitted because it is not runnable locally.',
        {
          command: 'pnpm run test:types',
          reason: 'TypeScript compiler checks are not a supported live validation target.',
          classification: 'unsupported-command',
          impact: 'Not included in live validation results.',
          source: {
            provider: 'github-actions',
            file: '.github/workflows/test.yml',
            workflow: 'test',
            job: 'build',
            step: 'pnpm run test:types',
          },
        },
      ],
      frameworks: [
        {
          id: 'vitest:app',
          framework: 'vitest',
          frameworkVersion: '4.1.9',
          project: {
            name: 'example',
            root: tmpDir,
            packageJson: packageJsonPath,
          },
        },
      ],
    }
    const results = [
      {
        frameworkId: 'vitest:app',
        scenario: 'basic-reporting',
        status: 'pass',
        diagnosis: 'Basic Reporting passed.',
        evidence: {},
        artifacts: [],
      },
      {
        frameworkId: 'vitest:app',
        scenario: 'ci-wiring',
        status: 'fail',
        diagnosis: 'The identified CI test job does not configure Test Optimization initialization.',
        conclusion: 'confirmed_misconfigured',
        domain: 'ci_configuration',
        evidenceStrength: 'confirmed_static',
        evidence: {
          conclusion: 'confirmed_misconfigured',
          domain: 'ci_configuration',
          evidenceStrength: 'confirmed_static',
          recommendation: 'Add Test Optimization initialization to the selected CI test job.',
          monorepoFindings: [
            {
              id: 'turbo-env-pass-through',
              tool: 'turbo',
              reason: 'Turborepo can filter environment variables for tasks.',
              recommendation: 'Verify turbo.json pass-through settings preserve NODE_OPTIONS.',
            },
          ],
          ciRemediation: buildCiRemediation({
            id: 'vitest:app',
            framework: 'vitest',
            project: { name: 'example' },
            ciWiring: {
              provider: 'github-actions',
              configFile: path.join(tmpDir, '.github/workflows/test.yml'),
              job: 'unit',
              step: 'Run unit tests',
              command: 'pnpm test',
            },
          }),
        },
        artifacts: [],
      },
      {
        frameworkId: 'vitest:app',
        scenario: 'efd',
        status: 'pass',
        diagnosis: 'Early Flake Detection passed.',
        evidence: {},
        artifacts: [],
      },
      {
        frameworkId: 'vitest:app',
        scenario: 'atr',
        status: 'pass',
        diagnosis: 'Auto Test Retries passed.',
        evidence: {},
        artifacts: [],
      },
      {
        frameworkId: 'vitest:app',
        scenario: 'test-management',
        status: 'pass',
        diagnosis: 'Test Management passed.',
        evidence: {},
        artifacts: [],
      },
    ]
    const originalLog = console.log
    const logs = []

    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(packageJsonPath, `${JSON.stringify({ name: 'example' }, null, 2)}\n`)
    fs.writeFileSync(staticDiagnosisPath, '{}\n')
    console.log = message => logs.push(message)

    try {
      writeReport({
        manifest,
        results,
        out,
        runSummary: { runCompleted: true, validatorExitCode: 1 },
        staticDiagnosis: {
          report: {
            results: [
              {
                title: 'Missing Test Optimization initialization',
                status: 'error',
              },
            ],
          },
          reportPath: staticDiagnosisPath,
        },
      })

      const markdown = fs.readFileSync(path.join(out, 'report.md'), 'utf8')
      const humanReadableReport = markdown.split('<details><summary>Diagnostic JSON</summary>')[0]

      assert.ok(markdown.includes('example \\(Vitest\\): dd-trace successfully reports this test suite, but the ' +
        'identified CI job does not configure the required Test Optimization initialization or reporting transport.'))
      assert.ok(markdown.includes('Can these tests report to Datadog? \\(Basic Reporting\\)'))
      assert.ok(markdown.includes('Does the selected CI job initialize Datadog? \\(CI Configuration Audit\\)'))
      assert.match(markdown, /## How to Fix/)
      assert.ok(markdown.includes('### example \\(Vitest\\): CI Configuration Audit'))
      assert.match(markdown, /Add Test Optimization initialization to the selected CI test job\./)
      assert.match(markdown, /Verify turbo\.json pass-through settings preserve NODE\\_OPTIONS\./)
      assert.match(markdown, /#### Agentless reporting/)
      assert.match(markdown, /Recommended variables: `DD_SERVICE=example-tests`/)
      assert.match(markdown, /`DD_TEST_SESSION_NAME=vitest-unit-tests`/)
      assert.doesNotMatch(humanReadableReport, /DD_ENV|DD_TRACE_AGENT_URL/)
      assert.match(markdown, /## Static Diagnosis Notes/)
      assert.match(markdown, /not a direct-initialization Basic Reporting blocker/)
      assert.doesNotMatch(markdown, /## Not Validated/)
      assert.doesNotMatch(humanReadableReport, /pnpm run test:types was omitted/)
      assert.doesNotMatch(humanReadableReport, /pnpm run legacy-test was omitted/)
      assert.ok(markdown.includes('Typecheck commands \\(1 command\\): do not execute supported runtime tests.'))
      assert.match(markdown, /## Failed, Incomplete, and Blocked Result Details/)
      assert.match(markdown, /Monorepo finding: `turbo-env-pass-through`, `tool turbo`/)
      assert.match(markdown, /Are new tests retried\? .*The validator added a temporary passing test/)
      assert.match(markdown, /Are failed tests retried\? .*temporary test that fails once.*retry pass/)
      assert.match(markdown, /Can tests be quarantined\? .*temporary target test.*quarantine tag/)
      assert.match(markdown, /<details><summary>Diagnostic JSON<\/summary>/)
      assert.doesNotMatch(markdown, /## Validation Payloads JSON/)
      assert.doesNotMatch(markdown, /## Execution Results JSON/)
      assert.doesNotMatch(markdown, /## Normalized Manifest JSON/)
      assert.doesNotMatch(markdown, /## Static Diagnosis JSON/)
      const diagnostic = readMarkdownJsonSection(markdown, 'Diagnostic JSON')
      const validation = diagnostic.validationSummaries[0]
      const ciWiring = validation.checks.find(check => check.id === 'ci-wiring')
      assert.strictEqual(validation.status, 'failed')
      assert.strictEqual(ciWiring.command, undefined)
      assert.strictEqual(ciWiring.exitCode, undefined)
      assert.strictEqual(ciWiring.evidence.conclusion, 'confirmed_misconfigured')
      assert.strictEqual(ciWiring.artifactDirectory, undefined)
      assert.ok(ciWiring.remediation.length > 0)
      assert.strictEqual(diagnostic.normalizedManifest, undefined)
      assert.strictEqual(diagnostic.staticDiagnosis, undefined)
      assert.doesNotMatch(JSON.stringify(diagnostic), /stderrExcerpt|stdoutExcerpt|samples/)
      assert.ok(Buffer.byteLength(JSON.stringify(diagnostic)) < 10_000)
      const summary = logs.join('\n')
      assert.match(summary, /How to fix:/)
      assert.match(summary, /example \(Vitest\) - CI Configuration Audit:/)
      assert.match(summary, /Add Test Optimization initialization to the selected CI test job\./)
      assert.match(summary, /Verify turbo\.json pass-through settings preserve NODE_OPTIONS\./)
      assert.strictEqual(fs.existsSync(path.join(out, 'report.html')), false)
      assert.strictEqual(fs.existsSync(path.join(out, 'report.json')), false)
    } finally {
      console.log = originalLog
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('does not claim a CI command ran when the static audit is incomplete', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-report-'))
    const out = path.join(tmpDir, 'results')
    const packageJsonPath = path.join(tmpDir, 'package.json')
    const manifest = {
      repository: { root: tmpDir },
      frameworks: [{
        id: 'vitest:date-fns',
        framework: 'vitest',
        project: {
          name: 'date-fns',
          root: tmpDir,
          packageJson: packageJsonPath,
        },
      }],
    }
    const results = [{
      frameworkId: 'vitest:date-fns',
      scenario: 'ci-wiring',
      status: 'error',
      diagnosis: 'The CI configuration audit is incomplete. No CI configuration conclusion was reached.',
      evidence: {
        conclusion: 'incomplete',
        domain: 'ci_configuration',
        evidenceStrength: 'unknown',
      },
      artifacts: [],
    }]
    const originalLog = console.log
    const logs = []
    fs.writeFileSync(packageJsonPath, '{}\n')
    fs.mkdirSync(out)
    console.log = message => logs.push(message)

    try {
      writeReport({
        manifest,
        results,
        out,
        runSummary: { runCompleted: true, validatorExitCode: 1 },
      })

      const summary = logs.join('\n')
      const markdown = fs.readFileSync(path.join(out, 'report.md'), 'utf8')
      assert.match(summary, /CI configuration audit is incomplete/)
      assert.match(summary, /No CI configuration conclusion was reached/)
      assert.doesNotMatch(summary, /CI ran tests/)
      assert.doesNotMatch(markdown, /Missing event levels:/)
    } finally {
      console.log = originalLog
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('reports a confirmed static CI finding without claiming the CI command ran', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-report-static-ci-'))
    const out = path.join(root, 'results')
    const manifest = {
      repository: { root },
      frameworks: [{
        id: 'vitest:root',
        framework: 'vitest',
        project: { name: 'example', root },
      }],
    }
    const results = [{
      frameworkId: 'vitest:root',
      scenario: 'basic-reporting',
      status: 'pass',
      diagnosis: 'Basic Reporting passed.',
      conclusion: 'confirmed_working',
      domain: 'test_optimization',
      evidenceStrength: 'confirmed_runtime',
      evidence: {},
      artifacts: [],
    }, {
      frameworkId: 'vitest:root',
      scenario: 'ci-wiring',
      status: 'fail',
      diagnosis: 'The identified CI test job does not configure NODE_OPTIONS with dd-trace/ci/init.',
      conclusion: 'confirmed_misconfigured',
      domain: 'ci_configuration',
      evidenceStrength: 'confirmed_static',
      evidence: {},
      artifacts: [],
    }]
    fs.mkdirSync(out)

    try {
      writeReport({
        manifest,
        results,
        out,
        runSummary: {
          runCompleted: true,
          executionStatus: 'completed',
          validatorExitCode: 1,
          validationCoverage: 'complete',
        },
      })

      const markdown = fs.readFileSync(path.join(out, 'report.md'), 'utf8')
      assert.match(markdown, /identified CI job does not configure the required Test Optimization/)
      assert.match(markdown, /does not configure NODE_OPTIONS with dd-trace\/ci\/init/)
      assert.doesNotMatch(markdown, /CI ran tests/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('marks skipped framework entries as diagnostic-only in the human report', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-report-'))
    const out = path.join(tmpDir, 'results')
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const packageJsonPath = path.join(tmpDir, 'package.json')
    const manifest = {
      __path: manifestPath,
      repository: {
        root: tmpDir,
      },
      frameworks: [
        {
          id: 'jest:db-package',
          framework: 'jest',
          frameworkVersion: '29.7.0',
          project: {
            name: 'example',
            root: tmpDir,
            packageJson: packageJsonPath,
          },
        },
        {
          id: 'node:test:root',
          framework: 'node:test',
          project: {
            name: 'node-tests',
            root: tmpDir,
            packageJson: packageJsonPath,
          },
        },
      ],
    }
    const results = [
      {
        frameworkId: 'jest:db-package',
        scenario: 'all',
        status: 'skip',
        diagnosis: 'jest was detected, but no runnable validation command was available.',
        evidence: {
          frameworkStatus: 'requires_external_service',
        },
        artifacts: [],
      },
      {
        frameworkId: 'node:test:root',
        scenario: 'all',
        status: 'skip',
        diagnosis: 'node:test is not supported by the validator.',
        evidence: {
          frameworkStatus: 'unsupported_by_validator',
        },
        artifacts: [],
      },
    ]
    const originalLog = console.log

    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(packageJsonPath, `${JSON.stringify({ name: 'example' }, null, 2)}\n`)
    console.log = () => {}

    try {
      writeReport({
        manifest,
        results,
        out,
        runSummary: { runCompleted: true, validatorExitCode: 1 },
        staticDiagnosis: {
          report: {
            results: [{ title: 'Missing Test Optimization initialization' }],
          },
        },
      })

      const markdown = fs.readFileSync(path.join(out, 'report.md'), 'utf8')

      assert.match(markdown, /## Scope/)
      assert.match(markdown, /No live Test Optimization validation ran/)
      assert.match(markdown, /result is incomplete/)
      assert.match(markdown, /Treat this as context only, not as a confirmed CI-wiring failure or remediation/)
      assert.ok(markdown.includes('requires project setup: example \\(Jest\\)'))
      assert.ok(markdown.includes('unsupported or non-runnable frameworks: node-tests \\(Node:test\\)'))
      assert.doesNotMatch(markdown, /not selected for live validation/)
      assert.doesNotMatch(markdown, /## Diagnostic-only and Blocked Frameworks/)
    } finally {
      console.log = originalLog
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('labels scenario-scoped validation as partial and shows every unselected check', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-report-coverage-'))
    const out = path.join(tmpDir, 'results')
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const manifest = {
      __path: manifestPath,
      repository: { root: tmpDir },
      frameworks: [{
        id: 'vitest:unit',
        framework: 'vitest',
        status: 'runnable',
        project: { name: 'unit tests', root: tmpDir },
      }, {
        id: 'jest:other',
        framework: 'jest',
        status: 'runnable',
        project: { name: 'other tests', root: tmpDir },
      }],
    }
    const originalLog = console.log
    const logs = []

    fs.mkdirSync(out)
    fs.writeFileSync(manifestPath, '{}\n')
    console.log = message => logs.push(message)

    try {
      writeReport({
        manifest,
        results: [{
          frameworkId: 'vitest:unit',
          scenario: 'basic-reporting',
          status: 'pass',
          diagnosis: 'Basic Reporting passed.',
          evidence: {},
          artifacts: [],
        }],
        out,
        runSummary: {
          runCompleted: true,
          validatorExitCode: 0,
          validationCoverage: 'partial',
          checkedScenarios: ['basic-reporting'],
          omittedScenarios: ['ci-wiring', 'efd', 'atr', 'test-management'],
          requestedScenario: 'basic-reporting',
          selectedFrameworkIds: ['vitest:unit'],
        },
      })

      const markdown = fs.readFileSync(path.join(out, 'report.md'), 'utf8')
      assert.match(markdown, /Validation coverage: partial/)
      assert.match(markdown, /did not check CI Configuration Audit, Early Flake Detection, Auto Test Retries, Test Management/)
      assert.strictEqual((markdown.match(/NOT CHECKED/g) || []).length, 4)
      assert.doesNotMatch(markdown, /other tests/)
      assert.match(logs.join('\n'), /Validation coverage: partial/)
      assert.match(logs.join('\n'), /NOT CHECKED unit tests \(Vitest\) - Does the selected CI job initialize Datadog/)
    } finally {
      console.log = originalLog
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('marks setup failures as diagnostic-only in the human report', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-report-'))
    const out = path.join(tmpDir, 'results')
    const packageJsonPath = path.join(tmpDir, 'package.json')
    const manifest = {
      repository: {
        root: tmpDir,
      },
      frameworks: [
        {
          id: 'jest:root',
          framework: 'jest',
          frameworkVersion: '29.7.0',
          project: {
            name: 'example',
            root: tmpDir,
            packageJson: packageJsonPath,
          },
        },
      ],
    }
    const results = [
      {
        frameworkId: 'jest:root',
        scenario: 'all',
        status: 'blocked',
        diagnosis: 'Validation is blocked by required project setup.',
        evidence: {
          blockedByProjectSetup: true,
          setupFailed: true,
          recommendation: 'Run the required project build, then rerun validation for this framework.',
        },
        artifacts: [],
      },
    ]
    const originalLog = console.log

    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(packageJsonPath, `${JSON.stringify({ name: 'example' }, null, 2)}\n`)
    console.log = () => {}

    try {
      writeReport({
        manifest,
        results,
        out,
      })

      const markdown = fs.readFileSync(path.join(out, 'report.md'), 'utf8')

      assert.ok(markdown.includes('Not validated: requires project setup: example \\(Jest\\)'))
      assert.ok(markdown.includes('### BLOCKED example \\(Jest\\) Validation Environment'))
      assert.match(markdown, /## How to Fix/)
      assert.match(markdown, /Run the required project build, then rerun validation for this framework\./)
      assert.doesNotMatch(markdown, /### Advanced Features/)
    } finally {
      console.log = originalLog
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('test optimization validation customer outcome decision table', () => {
  const decisionCases = [
    {
      name: 'reports working local instrumentation and missing CI configuration separately',
      results: [
        getDecisionResult('basic-reporting', 'pass'),
        getDecisionResult('ci-wiring', 'fail', {
          conclusion: 'confirmed_misconfigured',
          domain: 'ci_configuration',
          evidenceStrength: 'confirmed_static',
          recommendation: 'Add Test Optimization initialization to the identified CI test job.',
        }),
        ...getDecisionAdvancedResults('pass'),
      ],
      runSummary: { executionStatus: 'completed', validatorExitCode: 1, validationCoverage: 'complete' },
      expected: [
        /completed and found at least one confirmed actionable problem/,
        /dd-trace successfully reports this test suite, but the inspected CI configuration does not configure/,
        /Add Test Optimization initialization to the identified CI test job/,
      ],
      forbidden: [/CI ran tests/],
    },
    {
      name: 'reports successful local instrumentation with unverified CI propagation as incomplete',
      results: [
        getDecisionResult('basic-reporting', 'pass'),
        getDecisionResult('ci-wiring', 'error', {
          conclusion: 'configured_propagation_unverified',
          domain: 'ci_configuration',
          evidenceStrength: 'inferred_static',
        }),
        ...getDecisionAdvancedResults('pass'),
      ],
      runSummary: { executionStatus: 'completed', validatorExitCode: 2, validationCoverage: 'partial' },
      expected: [
        /completed, but one or more selected checks remain incomplete/,
        /contains the required configuration, but static analysis cannot prove that it reaches the final test process/,
      ],
      forbidden: [/including from the selected CI job/],
    },
    {
      name: 'keeps a local reporting failure separate from a missing CI configuration',
      results: [
        getDecisionResult('basic-reporting', 'fail'),
        getDecisionResult('ci-wiring', 'fail', {
          conclusion: 'confirmed_misconfigured',
          domain: 'ci_configuration',
          evidenceStrength: 'confirmed_static',
        }),
        ...getDecisionAdvancedResults('skip'),
      ],
      runSummary: { executionStatus: 'completed', validatorExitCode: 1, validationCoverage: 'complete' },
      expected: [
        /selected tests did not report when dd-trace was initialized directly/,
        /Separately, static inspection confirmed that the inspected CI configuration is missing/,
      ],
      forbidden: [/no local Test Optimization conclusion was reached/],
    },
    {
      name: 'reports missing project setup without implying a sandbox or product failure',
      results: [
        getDecisionResult('basic-reporting', 'error', {
          commandFailure: { kind: 'project-setup-failed' },
          recommendation: 'Complete the required project build, then rerun validation.',
        }),
        getDecisionResult('ci-wiring', 'error', {
          conclusion: 'incomplete',
          domain: 'ci_configuration',
          evidenceStrength: 'unknown',
        }),
      ],
      runSummary: { executionStatus: 'project_setup_required', validatorExitCode: 2, validationCoverage: 'partial' },
      expected: [
        /requires additional project setup before it can complete/,
        /local validation could not run because required project setup is unavailable/,
        /No Test Optimization reporting conclusion was reached/,
      ],
      forbidden: [/blocked by the execution environment/, /did not report successfully/],
    },
    {
      name: 'reports sandbox blocking without implying Test Optimization failed',
      results: [
        getDecisionResult('basic-reporting', 'blocked', { blockedByExecutionEnvironment: true }),
        getDecisionResult('ci-wiring', 'error', {
          conclusion: 'incomplete',
          domain: 'ci_configuration',
          evidenceStrength: 'unknown',
        }),
      ],
      runSummary: { executionStatus: 'blocked', validatorExitCode: 2, validationCoverage: 'partial' },
      expected: [
        /blocked by the execution environment before reaching a complete conclusion/,
        /local validation was blocked by the execution environment/,
        /No Test Optimization reporting conclusion was reached/,
      ],
      forbidden: [/did not report successfully/],
    },
    {
      name: 'surfaces an advanced-feature failure after Basic Reporting passes',
      results: [
        getDecisionResult('basic-reporting', 'pass'),
        getDecisionResult('ci-wiring', 'error', {
          conclusion: 'configured_propagation_unverified',
          domain: 'ci_configuration',
          evidenceStrength: 'inferred_static',
        }),
        getDecisionResult('atr', 'fail'),
      ],
      runSummary: { executionStatus: 'completed', validatorExitCode: 1, validationCoverage: 'complete' },
      expected: [
        /dd-trace successfully reports this test suite/,
        /Auto Test Retries did not pass/,
      ],
      forbidden: [/Every selected check reached a conclusive pass or fail result.*all passed/],
    },
  ]

  for (const decisionCase of decisionCases) {
    it(decisionCase.name, () => {
      const { markdown, summary } = renderDecisionReport(decisionCase)
      const output = `${summary}\n${markdown}`

      for (const pattern of decisionCase.expected) assert.match(output, pattern)
      for (const pattern of decisionCase.forbidden) assert.doesNotMatch(output, pattern)
    })
  }
})

function renderDecisionReport ({ results, runSummary }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-decision-'))
  const out = path.join(root, 'results')
  const originalLog = console.log
  const logs = []
  const manifest = {
    __path: path.join(root, 'dd-test-optimization-validation-manifest.json'),
    repository: { root },
    frameworks: [{
      id: 'vitest:root',
      framework: 'vitest',
      frameworkVersion: '4.1.0',
      project: { name: 'example', root },
    }],
  }

  fs.mkdirSync(out)
  console.log = message => logs.push(message)
  try {
    writeReport({
      manifest,
      results: annotateResults(results),
      out,
      runSummary: { runCompleted: true, ...runSummary },
    })
    return {
      markdown: fs.readFileSync(path.join(out, 'report.md'), 'utf8'),
      summary: logs.join('\n'),
    }
  } finally {
    console.log = originalLog
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function getDecisionResult (scenario, status, evidence = {}) {
  return {
    frameworkId: 'vitest:root',
    scenario,
    status,
    diagnosis: `Fixture ${scenario} ${status}.`,
    evidence,
    artifacts: [],
  }
}

function getDecisionAdvancedResults (status) {
  return ['efd', 'atr', 'test-management'].map(scenario => getDecisionResult(scenario, status,
    status === 'skip'
      ? { featureEligibility: { eligible: false, blockedBy: 'basic-reporting' } }
      : {}
  ))
}
