'use strict'

/* eslint-disable no-console */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const executionEnvironment = require('../../../../ci/test-optimization-validation/execution-environment')
const { MockIntake } = require('../../../../ci/test-optimization-validation/mock-intake')
const { writeReport } = require('../../../../ci/test-optimization-validation/report-writer')

const { buildExecutionEnvironmentBlockerResult } = executionEnvironment

function readMarkdownJsonSection (markdown, title) {
  const pattern = new RegExp(`## ${title}\\n\\n\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``)
  const match = pattern.exec(markdown)
  assert.ok(match, `Expected ${title} section`)
  return JSON.parse(match[1])
}

describe('test optimization validation report writer', () => {
  it('prints rerun remediation and preserves execution-environment blockers in report payloads', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-report-'))
    const out = path.join(tmpDir, 'results')
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const packageJsonPath = path.join(tmpDir, 'package.json')
    const staticDiagnosisPath = path.join(out, 'static-diagnosis.json')
    const error = Object.assign(new Error('listen EPERM: operation not permitted 127.0.0.1'), {
      address: '127.0.0.1',
      code: 'EPERM',
      syscall: 'listen',
    })
    const results = [
      buildExecutionEnvironmentBlockerResult({
        framework: { id: 'jest:root' },
        error,
        rerunCommand: 'node /repo/node_modules/dd-trace/ci/validate-test-optimization.js --manifest manifest.json',
      }),
    ]
    const manifest = {
      __path: manifestPath,
      repository: {
        root: tmpDir,
      },
      frameworks: [
        {
          id: 'jest:root',
          framework: 'jest',
          frameworkVersion: '30.1.3',
          project: {
            name: 'example',
            root: tmpDir,
            packageJson: packageJsonPath,
          },
        },
      ],
    }
    const intake = {
      requests: [],
      writeArtifacts () {
        const intakeDir = path.join(out, 'intake')
        fs.mkdirSync(intakeDir, { recursive: true })
        const requestsPath = path.join(intakeDir, 'requests.ndjson')
        fs.writeFileSync(requestsPath, '')
        return { requestsPath }
      },
    }
    const originalLog = console.log
    const logs = []

    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(packageJsonPath, `${JSON.stringify({ name: 'example' }, null, 2)}\n`)
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    fs.writeFileSync(staticDiagnosisPath, '{}\n')
    console.log = message => logs.push(message)

    try {
      writeReport({
        manifest,
        results,
        out,
        intake,
        staticDiagnosis: {
          reportPath: staticDiagnosisPath,
        },
      })

      const summary = logs.join('\n')
      assert.match(summary, /BLOCKED jest:root/)
      assert.match(summary, /not evidence that Test Optimization is misconfigured/)
      assert.match(summary, /manifest and generated artifacts may still be useful/)
      assert.match(summary, /Rerun the validator outside the restricted sandbox/)
      assert.match(summary, /Rerun the validator command shown below from the host shell/)
      assert.match(summary, /Rerun in CI/)
      assert.match(summary, /Command: node \/repo\/node_modules\/dd-trace\/ci\/validate-test-optimization\.js/)
      assert.match(summary, /Detailed report: .*report\.md/)

      const markdown = fs.readFileSync(path.join(out, 'report.md'), 'utf8')
      assert.match(markdown, /Sanitized intake requests/)
      assert.doesNotMatch(markdown, /Raw intake requests/)
      assert.match(markdown, /## Failed and Blocked Result Details/)
      assert.match(markdown, /Reason: The current agent sandbox blocks localhost sockets/)
      assert.match(markdown, /Error code: `EPERM`/)
      assert.match(markdown, /Rerun command: `node \/repo\/node_modules\/dd-trace\/ci\/validate-test-optimization/)

      const executionResults = readMarkdownJsonSection(markdown, 'Execution Results JSON')
      assert.strictEqual(executionResults[0].status, 'blocked')
      assert.strictEqual(executionResults[0].evidence.blockedByExecutionEnvironment, true)
      assert.strictEqual(executionResults[0].evidence.manifestMayBeReused, true)
      assert.deepStrictEqual(executionResults[0].evidence.remediation, [
        'Rerun the validator command shown below from the host shell',
        'Rerun in an agent mode that allows localhost sockets or with sandbox restrictions disabled for this command',
        'Rerun in CI',
      ])

      const validationPayloads = readMarkdownJsonSection(markdown, 'Validation Payloads JSON')
      const check = validationPayloads[0].payload.checks[0]
      assert.deepStrictEqual(Object.keys(validationPayloads[0]).sort(), ['frameworkId', 'payload'])
      assert.strictEqual(validationPayloads[0].payload.status, 'unknown')
      assert.strictEqual(check.id, 'execution-environment')
      assert.strictEqual(check.status, 'unknown')
      assert.notStrictEqual(check.id, 'basic-reporting')
      assert.strictEqual(fs.existsSync(path.join(out, 'report.json')), false)
      assert.strictEqual(fs.existsSync(path.join(out, 'report.html')), false)
      assert.strictEqual(fs.existsSync(path.join(out, 'manifest.normalized.json')), false)
      assert.strictEqual(fs.existsSync(path.join(out, 'validation-payloads.json')), false)
      assert.strictEqual(fs.existsSync(path.join(out, 'validation-url.txt')), false)
      assert.strictEqual(fs.existsSync(path.join(out, 'validation-urls.txt')), false)
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
    const intake = {
      requests: [],
      writeArtifacts () {
        const intakeDir = path.join(out, 'intake')
        fs.mkdirSync(intakeDir, { recursive: true })
        const requestsPath = path.join(intakeDir, 'requests.ndjson')
        fs.writeFileSync(requestsPath, '')
        return { requestsPath }
      },
    }
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
        intake,
        staticDiagnosis: {
          reportPath: staticDiagnosisPath,
        },
      })

      const markdown = fs.readFileSync(path.join(out, 'report.md'), 'utf8')
      assert.match(markdown, /Selected because: The unit job runs this step after dependency installation\./)
      assert.match(markdown, /Environment found in CI: workflow `NODE_OPTIONS=-r dd-trace\/ci\/init`/)
      assert.match(markdown, /step `DD_API_KEY=<redacted>`/)
      assert.match(markdown, /Package script expansion: `pnpm test` -> `vitest run`/)
      assert.match(markdown, /Runner\/tool chain: `GitHub Actions ubuntu-latest` -> `pnpm test` -> `vitest`/)
      assert.match(markdown, /Unresolved replay details: `Matrix node version was approximated locally\.`/)
      assert.match(markdown, /Command failure: The CI-shaped command failed before tests started/)
      assert.match(markdown, /Command failure recommendation: Make sure dd-trace is installed/)
      assert.match(markdown, /Command failure signals: `Error: Cannot find module 'dd-trace\/ci\/init'`/)
      assert.match(markdown, /CI debug lines: `dd-trace debug line`/)
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
    const intakeRequests = [
      {
        method: 'POST',
        url: '/api/v2/citestcycle',
        headers: {
          'dd-api-key': 'request-dd-api-key-secret',
          'x-api-key': 'request-x-api-key-secret',
          authorization: 'Bearer request-bearer-secret',
          'proxy-authorization': 'Basic request-proxy-secret',
          token: 'request-token-secret',
          cookie: 'session=request-cookie-secret',
          'set-cookie': 'session=request-set-cookie-secret',
        },
        payload: {
          events: [
            {
              type: 'test',
              content: {
                name: 'example test',
                meta: {
                  'test.name': 'example test',
                  'dd-api-key': 'normalized-dd-api-key-secret',
                  'x-api-key': 'normalized-x-api-key-secret',
                  authorization: 'Bearer normalized-bearer-secret',
                  cookie: 'normalized-cookie-secret',
                  message: 'api-key: normalized-header-secret',
                },
                metrics: {},
              },
            },
          ],
        },
      },
    ]
    const intake = {
      requests: intakeRequests,
      writeArtifacts () {
        const intakeDir = path.join(out, 'intake')
        fs.mkdirSync(intakeDir, { recursive: true })
        const requestsPath = path.join(intakeDir, 'requests.ndjson')
        fs.writeFileSync(requestsPath, '')
        return { requestsPath }
      },
    }
    const originalLog = console.log

    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(packageJsonPath, `${JSON.stringify({ name: 'example' }, null, 2)}\n`)
    fs.writeFileSync(staticDiagnosisPath, '{}\n')
    fs.writeFileSync(commandPath, `${JSON.stringify({
      command: 'DD_API_KEY=artifact-secret pnpm test --token artifact-token',
      cwd: tmpDir,
      exitCode: 0,
    }, null, 2)}\n`)
    console.log = () => {}

    try {
      writeReport({
        manifest,
        results,
        out,
        intake,
        staticDiagnosis: {
          reportPath: staticDiagnosisPath,
        },
      })

      const reportFacingOutput = fs.readFileSync(path.join(out, 'report.md'), 'utf8')
      const executionResults = readMarkdownJsonSection(reportFacingOutput, 'Execution Results JSON')
      const normalizedManifest = readMarkdownJsonSection(reportFacingOutput, 'Normalized Manifest JSON')

      assert.match(reportFacingOutput, /not public-shareable as-is/)
      assert.match(reportFacingOutput, /best-effort/)
      assert.strictEqual(normalizedManifest.environment.safeEnv.DD_API_KEY, '<redacted>')
      assert.deepStrictEqual(normalizedManifest.environment.requiredSecretEnvVars, ['DD_API_KEY'])
      assert.strictEqual(
        normalizedManifest.frameworks[0].ciWiringCommand.env.DD_API_KEY,
        '<redacted>'
      )
      assert.strictEqual(executionResults[0].evidence.ciWiring.stepEnv.DD_API_KEY, '<redacted>')
      const normalizedPayloads = fs.readFileSync(path.join(out, 'intake', 'payloads.normalized.ndjson'), 'utf8')
      assert.match(normalizedPayloads, /<redacted>/)
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
        assert.doesNotMatch(normalizedPayloads, new RegExp(secret))
      }
    } finally {
      console.log = originalLog
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('redacts secret-like values from mock intake request artifacts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-report-'))
    const intake = new MockIntake({ out: tmpDir })

    try {
      intake.requests = [
        {
          method: 'POST',
          url: '/api/v2/citestcycle',
          headers: {
            'dd-api-key': 'dd-api-key-secret',
            'x-api-key': 'x-api-key-secret',
            'api-key': 'api-key-secret',
            authorization: 'Bearer authorization-secret',
            'proxy-authorization': 'Basic proxy-authorization-secret',
            token: 'token-secret',
            cookie: 'cookie-secret',
            'set-cookie': 'set-cookie-secret',
          },
          payload: {
            message: 'dd-api-key: header-secret\nAuthorization: Bearer bearer-secret',
            token: 'payload-token-secret',
            cookie: 'payload-cookie-secret',
          },
        },
      ]

      const { requestsPath } = intake.writeArtifacts()
      const requests = fs.readFileSync(requestsPath, 'utf8')

      assert.match(requests, /<redacted>/)
      for (const secret of [
        'dd-api-key-secret',
        'x-api-key-secret',
        'api-key-secret',
        'authorization-secret',
        'proxy-authorization-secret',
        'token-secret',
        'cookie-secret',
        'set-cookie-secret',
        'header-secret',
        'bearer-secret',
        'payload-token-secret',
        'payload-cookie-secret',
      ]) {
        assert.doesNotMatch(requests, new RegExp(secret))
      }
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
          initializationProbe: {
            ran: true,
            processCount: 2,
            reachedAnyNodeProcess: true,
            reachedTestRunnerProcess: false,
            wrapperSignals: [
              {
                name: 'turbo',
                pid: 123,
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
        },
        artifacts: [
          commandPath,
          stdoutPath,
          stderrPath,
        ],
      },
    ]
    const intake = {
      requests: [],
      writeArtifacts () {
        const intakeDir = path.join(out, 'intake')
        fs.mkdirSync(intakeDir, { recursive: true })
        const requestsPath = path.join(intakeDir, 'requests.ndjson')
        fs.writeFileSync(requestsPath, '')
        return { requestsPath }
      },
    }
    const originalLog = console.log

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
    console.log = () => {}

    try {
      writeReport({
        manifest,
        results,
        out,
        intake,
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

      assert.match(markdown, /## Static Diagnosis Notes/)
      assert.match(markdown, /not a direct-initialization Basic Reporting blocker/)
      assert.match(markdown, /## Omitted Test Commands/)
      assert.match(markdown, /pnpm run test:types was omitted/)
      assert.match(markdown, /command `pnpm run test:types`/)
      assert.match(markdown, /## Failed and Blocked Result Details/)
      assert.match(markdown, /Command: `pnpm test`/)
      assert.match(markdown, /Cwd: `/)
      assert.match(markdown, /Exit code: `1`/)
      assert.match(markdown, /Timed out: `false`/)
      assert.match(markdown, /Command output summary: `Tests {2}1 failed \| 2 passed \(3\)`/)
      assert.match(markdown, /Stderr excerpt: `AssertionError: expected true to be false`/)
      assert.match(markdown, /Event failure kind: `ci-wiring-no-test-optimization-events`/)
      assert.match(markdown, /NODE_OPTIONS probe: reached Node process `true`, reached test runner `false`/)
      assert.match(markdown, /Probe wrapper signals: `turbo pid 123 cwd /)
      assert.match(markdown, /Monorepo finding: `turbo-env-pass-through`, `tool turbo`/)
      assert.match(markdown, /Artifacts: `.*command\.json`, `.*stdout\.txt`, `.*stderr\.txt`/)
      assert.match(markdown, /## Validation Payloads JSON/)
      assert.match(markdown, /## Execution Results JSON/)
      assert.match(markdown, /## Normalized Manifest JSON/)
      assert.match(markdown, /## Static Diagnosis JSON/)
      assert.strictEqual(fs.existsSync(path.join(out, 'report.html')), false)
      assert.strictEqual(fs.existsSync(path.join(out, 'report.json')), false)
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
    const intake = {
      requests: [],
      writeArtifacts () {
        const intakeDir = path.join(out, 'intake')
        fs.mkdirSync(intakeDir, { recursive: true })
        const requestsPath = path.join(intakeDir, 'requests.ndjson')
        fs.writeFileSync(requestsPath, '')
        return { requestsPath }
      },
    }
    const originalLog = console.log

    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(packageJsonPath, `${JSON.stringify({ name: 'example' }, null, 2)}\n`)
    console.log = () => {}

    try {
      writeReport({
        manifest,
        results,
        out,
        intake,
      })

      const markdown = fs.readFileSync(path.join(out, 'report.md'), 'utf8')

      assert.match(markdown, /## Diagnostic-only and Blocked Frameworks/)
      assert.match(markdown, /SKIP jest:db-package/)
      assert.match(markdown, /Diagnostic-only: no live Test Optimization conclusion was reached/)
      assert.match(markdown, /not safely validated in this environment/)
    } finally {
      console.log = originalLog
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
