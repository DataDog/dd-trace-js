'use strict'

/* eslint-disable no-console */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { buildCiRemediation } = require('../../../../ci/test-optimization-validation/ci-remediation')
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
          },
          ciWiringCommand: {
            cwd: tmpDir,
            argv: ['pnpm', 'test'],
            env: {
              NODE_OPTIONS: '-r dd-trace/ci/init',
              DD_API_KEY: 'safe-placeholder',
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
        diagnosis: 'The test command used by the CI job was identified and ran tests.',
        evidence: {
          commandExitCode: 0,
          commandFailure: {
            kind: 'ci-wiring-preload-resolution-failed',
            summary: 'The CI-shaped command failed before tests started because Node could not resolve the ' +
              'Test Optimization preload.',
            recommendation: 'Make sure dd-trace is installed where the CI command starts.',
            signals: [
              "Error: Cannot find module 'dd-trace/ci/init'",
            ],
          },
          debugSignals: {
            debugEnvEnabled: true,
            lines: [
              'dd-trace debug line',
            ],
          },
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
      assert.match(markdown, /Unresolved replay details: `Matrix node version was approximated locally\.`/)
      assert.match(markdown, /Command failure: The CI-shaped command failed before tests started/)
      assert.match(markdown, /Command failure recommendation: Make sure dd-trace is installed/)
      assert.match(markdown, /Command failure signals: `Error: Cannot find module 'dd-trace\/ci\/init'`/)
      assert.match(markdown, /CI debug lines: `dd-trace debug line`/)
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
          },
          ciWiringCommand: {
            cwd: tmpDir,
            usesShell: true,
            shellCommand: 'DD_API_KEY=command-secret pnpm test --token flag-secret',
            env: {
              DD_API_KEY: 'command-env-secret',
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
    const runDir = path.join(out, 'runs', 'vitest-app', 'ci-wiring')
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const packageJsonPath = path.join(tmpDir, 'package.json')
    const staticDiagnosisPath = path.join(out, 'static-diagnosis.json')
    const commandPath = path.join(runDir, 'command.json')
    const stdoutPath = path.join(runDir, 'stdout.txt')
    const stderrPath = path.join(runDir, 'stderr.txt')
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
        diagnosis: 'The test command used by the CI job was identified and ran tests.',
        evidence: {
          commandExitCode: 1,
          commandTimedOut: false,
          commandOutputSummary: ['Tests  1 failed | 2 passed (3)'],
          commandFailure: {
            stdoutExcerpt: ['Tests  1 failed | 2 passed (3)'],
            stderrExcerpt: ['AssertionError: expected true to be false'],
          },
          eventLevelFailure: {
            kind: 'ci-wiring-no-test-optimization-events',
            missingLevels: ['test_session_end', 'test'],
            recommendation: 'Verify NODE_OPTIONS reaches Vitest.',
          },
          ciConfigurationDiagnosis: 'The CI step invokes test instead of test:datadog.',
          existingDatadogInitScripts: [
            {
              name: 'test:datadog',
              packageJson: packageJsonPath,
            },
          ],
          initializationProbe: {
            ran: true,
            processCount: 2,
            reachedAnyNodeProcess: true,
            reachedTestRunnerProcess: false,
            wrapperSignals: [
              {
                name: 'turbo',
                pid: 123,
                processCount: 12,
                cwd: tmpDir,
              },
            ],
            testRunnerSignals: [],
            packageManagerSignals: [],
            recordsPath: path.join(runDir, 'initialization-probe', 'records.ndjson'),
          },
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
            },
            ciWiringCommand: {
              cwd: tmpDir,
              argv: ['pnpm', 'test'],
            },
          }),
        },
        artifacts: [
          commandPath,
          stdoutPath,
          stderrPath,
        ],
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

    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(packageJsonPath, `${JSON.stringify({ name: 'example' }, null, 2)}\n`)
    fs.writeFileSync(staticDiagnosisPath, '{}\n')
    fs.writeFileSync(stdoutPath, 'Tests  1 failed | 2 passed (3)\n')
    fs.writeFileSync(stderrPath, 'AssertionError: expected true to be false\n')
    fs.writeFileSync(commandPath, `${JSON.stringify({
      command: 'pnpm test',
      displayCommand: 'pnpm test',
      cwd: tmpDir,
      exitCode: 1,
      timedOut: false,
      durationMs: 1234,
    }, null, 2)}\n`)
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
        'selected CI job does not load dd-trace when it runs the tests.'))
      assert.ok(markdown.includes('Can these tests report to Datadog? \\(Basic Reporting\\)'))
      assert.ok(markdown.includes('Does the selected CI job initialize Datadog? \\(CI Wiring\\)'))
      assert.match(markdown, /## How to Fix/)
      assert.ok(markdown.includes('### example \\(Vitest\\): CI Wiring'))
      assert.match(markdown, /Verify NODE\\_OPTIONS reaches Vitest\./)
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
      assert.match(markdown, /## Failed and Blocked Result Details/)
      assert.match(markdown, /Command: `pnpm test`/)
      assert.match(markdown, /Cwd: `/)
      assert.match(markdown, /Exit code: `1`/)
      assert.match(markdown, /Timed out: `false`/)
      assert.match(markdown, /Command output summary: `Tests {2}1 failed \| 2 passed \(3\)`/)
      assert.match(markdown, /Manifest CI configuration diagnosis: The CI step invokes test instead of test:datadog\./)
      assert.match(markdown, /Existing package scripts with Datadog initialization: `test:datadog \(/)
      assert.match(markdown, /Stderr excerpt: `AssertionError: expected true to be false`/)
      assert.match(markdown, /Event failure kind: `ci-wiring-no-test-optimization-events`/)
      assert.match(markdown, /NODE\\_OPTIONS probe: reached Node process `true`, reached test runner `false`/)
      assert.match(markdown, /Probe wrapper signals: `turbo 12 processes cwd /)
      assert.match(markdown, /Monorepo finding: `turbo-env-pass-through`, `tool turbo`/)
      assert.match(markdown, /Scenario artifacts: \[open artifact directory\]\(<runs\/vitest-app\/ci-wiring\/>\)/)
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
      assert.strictEqual(ciWiring.command, 'pnpm test')
      assert.strictEqual(ciWiring.exitCode, '1')
      assert.strictEqual(ciWiring.evidence.failureKind, 'ci-wiring-no-test-optimization-events')
      assert.strictEqual(ciWiring.evidence.initializationProbe.reachedTestRunnerProcess, false)
      assert.strictEqual(ciWiring.artifactDirectory, 'runs/vitest-app/ci-wiring')
      assert.ok(ciWiring.remediation.length > 0)
      assert.strictEqual(diagnostic.normalizedManifest, undefined)
      assert.strictEqual(diagnostic.staticDiagnosis, undefined)
      assert.doesNotMatch(JSON.stringify(diagnostic), /stderrExcerpt|stdoutExcerpt|samples/)
      assert.ok(Buffer.byteLength(JSON.stringify(diagnostic)) < 10_000)
      const summary = logs.join('\n')
      assert.match(summary, /How to fix:/)
      assert.match(summary, /example \(Vitest\) - CI Wiring:/)
      assert.match(summary, /Verify NODE_OPTIONS reaches Vitest\./)
      assert.match(summary, /Verify turbo\.json pass-through settings preserve NODE_OPTIONS\./)
      assert.strictEqual(fs.existsSync(path.join(out, 'report.html')), false)
      assert.strictEqual(fs.existsSync(path.join(out, 'report.json')), false)
    } finally {
      console.log = originalLog
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('does not claim a CI command ran for a static-only wiring failure', () => {
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
      status: 'fail',
      diagnosis: 'Static CI inspection found no Datadog initialization.',
      evidence: {
        eventLevelFailure: {
          kind: 'ci-wiring-static-missing-initialization',
          missingLevels: ['test_session_end', 'test'],
        },
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
      assert.match(summary, /Static CI inspection found no Datadog initialization/)
      assert.match(summary, /CI command was not replayed locally/)
      assert.doesNotMatch(summary, /CI ran tests/)
      assert.doesNotMatch(markdown, /Missing event levels:/)
      assert.ok(markdown.includes('Event levels that require CI initialization \\(static inference\\)'))
    } finally {
      console.log = originalLog
      fs.rmSync(tmpDir, { recursive: true, force: true })
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

      assert.match(markdown, /## Scope/)
      assert.ok(markdown.includes('requires project setup: example \\(Jest\\)'))
      assert.doesNotMatch(markdown, /## Diagnostic-only and Blocked Frameworks/)
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
