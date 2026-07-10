'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { buildValidationPayloads } = require('../../../../ci/test-optimization-validation/validation-payload')

describe('test optimization validation payload', () => {
  it('omits fake intake setup from successful live-run steps', () => {
    const [{ payload }] = buildValidationPayloads({
      manifest: {
        frameworks: [
          {
            id: 'mocha:root',
            framework: 'mocha',
            frameworkVersion: '11.7.6',
            language: 'typescript',
            project: {
              name: 'example-package',
              root: '/repo/packages/example-package',
              packageJson: '/repo/packages/example-package/package.json',
            },
            existingTestCommand: {
              cwd: '/repo/packages/example-package/test-workdir',
            },
            ciWiring: {
              provider: 'github-actions',
              configFile: '/repo/.github/workflows/test.yml',
              workflow: 'test',
              job: 'unit',
              step: 'Run tests',
              inheritedEnv: {
                NODE_OPTIONS: '-r dd-trace/ci/init',
                DD_API_KEY: 'secret-value',
              },
              diagnosis: 'Selected because the workflow step runs the package unit tests.',
              runnerToolChain: ['pnpm test', 'jest'],
            },
            ciWiringCommand: {
              cwd: '/repo/packages/example-package',
              argv: ['pnpm', 'test'],
              env: {
                NODE_OPTIONS: '-r dd-trace/ci/init',
                DD_API_KEY: 'secret-value',
              },
            },
          },
        ],
      },
      results: [
        {
          frameworkId: 'mocha:root',
          scenario: 'basic-reporting',
          status: 'pass',
          diagnosis: 'Basic reporting emitted session, module, suite, and test events.',
          evidence: {
            commandExitCode: 0,
            testSessionEvents: 1,
            testModuleEvents: 1,
            testSuiteEvents: 1,
            testEvents: 2,
          },
          artifacts: [],
        },
      ],
      artifacts: {
        reportPath: '/tmp/report.md',
      },
    })

    assert.deepStrictEqual(payload.ciCommandCandidate, {
      provider: 'github-actions',
      configFile: '/repo/.github/workflows/test.yml',
      workflow: 'test',
      job: 'unit',
      step: 'Run tests',
      command: 'pnpm test',
      cwd: '/repo/packages/example-package',
      whySelected: 'Selected because the workflow step runs the package unit tests.',
      env: {
        step: {
          NODE_OPTIONS: '-r dd-trace/ci/init',
          DD_API_KEY: '<redacted>',
        },
        inherited: {
          NODE_OPTIONS: '-r dd-trace/ci/init',
          DD_API_KEY: '<redacted>',
        },
      },
      runnerToolChain: ['pnpm test', 'jest'],
    })
    assert.deepStrictEqual(payload.checks[0].steps.map(step => step.id), [
      'run-tests',
      'check-events',
    ])
    assert.deepStrictEqual(payload.artifacts, {
      reportPath: '/tmp/report.md',
    })
    assert.deepStrictEqual(payload.framework, {
      id: 'mocha',
      name: 'Mocha',
      version: '11.7.6',
      language: 'typescript',
      packageName: 'example-package',
      workingDirectory: '/repo/packages/example-package',
      commandWorkingDirectory: '/repo/packages/example-package/test-workdir',
      projectRoot: '/repo/packages/example-package',
      packageJson: '/repo/packages/example-package/package.json',
    })
  })

  it('uses display commands and keeps runtime plumbing as compact evidence', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-payload-'))
    const commandPath = path.join(tmpDir, 'command.json')
    const exactCommand = '/usr/bin/env ' +
      'PATH=/Users/example/.nvm/versions/node/v22.22.2/bin:/usr/bin ' +
      '/Users/example/.nvm/versions/node/v22.22.2/bin/node ' +
      '/Users/example/.nvm/versions/node/v22.22.2/lib/node_modules/corepack/dist/corepack.js ' +
      'pnpm vitest run packages/zod/src/index.test.ts'

    try {
      fs.writeFileSync(commandPath, `${JSON.stringify({ command: exactCommand }, null, 2)}\n`)

      const [{ payload }] = buildValidationPayloads({
        manifest: {
          frameworks: [
            {
              id: 'vitest:root',
              framework: 'vitest',
              frameworkVersion: '4.1.5',
            },
          ],
        },
        results: [
          {
            frameworkId: 'vitest:root',
            scenario: 'basic-reporting',
            status: 'pass',
            diagnosis: 'Basic reporting emitted session, module, suite, and test events.',
            evidence: {
              commandExitCode: 0,
              testSessionEvents: 1,
              testModuleEvents: 1,
              testSuiteEvents: 1,
              testEvents: 1,
            },
            artifacts: [commandPath],
          },
        ],
        artifacts: {
          reportPath: '/tmp/report.md',
        },
      })

      assert.strictEqual(
        payload.checks[0].steps[0].command,
        'pnpm vitest run packages/zod/src/index.test.ts'
      )
      assert.deepStrictEqual(payload.checks[0].steps[0].evidence.commandDetails, {
        exactCommandCollapsed: true,
        pathAdjusted: true,
        runtimeWrapper: 'node/corepack',
        packageManager: 'pnpm',
      })
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('reports localhost socket blockers as execution-environment checks', () => {
    const reason = 'The current agent sandbox blocks localhost sockets, so the validator could not start the fake ' +
      'Datadog intake.'
    const [{ payload }] = buildValidationPayloads({
      manifest: {
        frameworks: [
          {
            id: 'mocha:root',
            framework: 'mocha',
            frameworkVersion: '11.7.6',
          },
        ],
      },
      results: [
        {
          frameworkId: 'mocha:root',
          scenario: 'all',
          status: 'blocked',
          diagnosis: 'No Test Optimization conclusion was reached.',
          evidence: {
            intakeStarted: false,
            blockedByExecutionEnvironment: true,
            localNetworkingBlocked: true,
            manifestMayBeReused: true,
            reason,
            error: 'listen EPERM: operation not permitted 127.0.0.1',
            errorCode: 'EPERM',
            errorSyscall: 'listen',
            errorAddress: '127.0.0.1',
            remediation: [
              'Rerun the validator command shown below from the host shell',
              'Rerun in an agent mode that allows localhost sockets while retaining credential, outbound-network, ' +
                'and filesystem restrictions',
              'Rerun in CI',
            ],
            rerunCommand: 'node /repo/node_modules/dd-trace/ci/validate-test-optimization.js --manifest manifest.json',
          },
          artifacts: [],
        },
      ],
      artifacts: {
        reportPath: '/tmp/report.md',
      },
    })

    assert.strictEqual(payload.status, 'unknown')
    assert.strictEqual(payload.checks[0].id, 'execution-environment')
    assert.strictEqual(payload.checks[0].name, 'Local fake intake')
    assert.strictEqual(payload.checks[0].status, 'unknown')
    assert.strictEqual(payload.checks[0].reason, reason)
    assert.deepStrictEqual(payload.checks[0].remediation, [
      'Rerun the validator command shown below from the host shell',
      'Rerun in an agent mode that allows localhost sockets while retaining credential, outbound-network, and ' +
        'filesystem restrictions',
      'Rerun in CI',
    ])
    assert.deepStrictEqual(payload.checks[0].evidence, {
      blockedByExecutionEnvironment: true,
      localNetworkingBlocked: true,
      manifestMayBeReused: true,
      intakeStarted: false,
      error: 'listen EPERM: operation not permitted 127.0.0.1',
      errorCode: 'EPERM',
      errorSyscall: 'listen',
      errorAddress: '127.0.0.1',
      rerunCommand: 'node /repo/node_modules/dd-trace/ci/validate-test-optimization.js --manifest manifest.json',
    })
    assert.deepStrictEqual(payload.checks[0].steps, [])
  })

  it('includes command and debug excerpts for basic reporting failures after tests ran', () => {
    const [{ payload }] = buildValidationPayloads({
      manifest: {
        frameworks: [
          {
            id: 'mocha:root',
            framework: 'mocha',
            frameworkVersion: '12.0.0-rc.1',
          },
        ],
      },
      results: [
        {
          frameworkId: 'mocha:root',
          scenario: 'basic-reporting',
          status: 'fail',
          diagnosis: 'The selected command ran tests, but no Test Optimization events reached the fake intake.',
          evidence: {
            commandExitCode: 0,
            commandOutputSummary: ['1 passing (2ms)'],
            testSessionEvents: 0,
            testModuleEvents: 0,
            testSuiteEvents: 0,
            testEvents: 0,
            debugRerun: {
              ran: true,
              debugLines: ['dd-trace is not initialized in a package manager.'],
              stdoutExcerpt: ['1 passing (1ms)'],
            },
            localDiagnosis: {
              kind: 'tests-ran-tracer-not-initialized',
            },
          },
          artifacts: [],
        },
      ],
      artifacts: {
        reportPath: '/tmp/report.md',
      },
    })

    assert.strictEqual(payload.checks[0].steps[0].result, '1 passing (2ms)')
    assert.deepStrictEqual(payload.checks[0].steps[0].evidence.outputSummary, ['1 passing (2ms)'])
    assert.deepStrictEqual(payload.checks[0].steps[1].evidence.debugExcerpt, [
      'dd-trace is not initialized in a package manager.',
      '1 passing (1ms)',
    ])
    assert.strictEqual(payload.checks[0].steps[1].evidence.localDiagnosis.kind, 'tests-ran-tracer-not-initialized')
  })

  it('includes CI wiring command failure and debug evidence', () => {
    const [{ payload }] = buildValidationPayloads({
      manifest: {
        frameworks: [
          {
            id: 'mocha:fixture',
            framework: 'mocha',
            frameworkVersion: '11.7.6',
          },
        ],
      },
      results: [
        {
          frameworkId: 'mocha:fixture',
          scenario: 'ci-wiring',
          status: 'fail',
          diagnosis: 'The CI-shaped command failed before tests started.',
          evidence: {
            commandExitCode: 1,
            commandFailure: {
              kind: 'ci-wiring-preload-resolution-failed',
              summary: 'Node could not resolve dd-trace/ci/init.',
              recommendation: 'Install dd-trace where the CI command starts.',
              signals: [
                "Cannot find module 'dd-trace/ci/init'",
              ],
            },
            debugSignals: {
              debugEnvEnabled: true,
              lines: [
                'dd-trace debug enabled',
              ],
            },
          },
          artifacts: [],
        },
      ],
      artifacts: {
        reportPath: '/tmp/report.md',
      },
    })

    const evidence = payload.checks[0].steps[1].evidence
    assert.strictEqual(evidence.commandFailure.kind, 'ci-wiring-preload-resolution-failed')
    assert.deepStrictEqual(evidence.commandFailure.signals, [
      "Cannot find module 'dd-trace/ci/init'",
    ])
    assert.deepStrictEqual(evidence.debugSignals.lines, [
      'dd-trace debug enabled',
    ])
  })

  it('redacts secret-like values from validation payload evidence', () => {
    const [validationPayload] = buildValidationPayloads({
      manifest: {
        frameworks: [
          {
            id: 'vitest:root',
            framework: 'vitest',
            frameworkVersion: '4.1.9',
            ciWiring: {
              provider: 'github-actions',
              workflow: 'test',
              stepEnv: {
                DD_API_KEY: 'payload-step-secret',
              },
            },
            ciWiringCommand: {
              cwd: '/repo',
              usesShell: true,
              shellCommand: 'DD_API_KEY=payload-command-secret pnpm test --token payload-flag-secret',
              env: {
                DD_API_KEY: 'payload-env-secret',
              },
            },
          },
        ],
      },
      results: [
        {
          frameworkId: 'vitest:root',
          scenario: 'ci-wiring',
          status: 'fail',
          diagnosis: 'The CI job ran tests but no Test Optimization events reached the intake.',
          evidence: {
            commandExitCode: 0,
            commandOutputSummary: ['DD_API_KEY=payload-output-secret Tests 1 passed'],
            ciWiring: {
              inheritedEnv: {
                ACCESS_TOKEN: 'payload-inherited-secret',
              },
            },
            eventLevelFailure: {
              recommendation: 'Rerun without Authorization: Bearer payload-bearer-secret',
            },
          },
          artifacts: [],
        },
      ],
      artifacts: {
        reportPath: '/tmp/report.md',
      },
    })
    const { payload } = validationPayload
    const serializedPayload = JSON.stringify(payload)

    assert.deepStrictEqual(Object.keys(validationPayload).sort(), ['frameworkId', 'payload'])
    assert.match(serializedPayload, /<redacted>/)
    assert.strictEqual(payload.ciCommandCandidate.env.step.DD_API_KEY, '<redacted>')
    assert.strictEqual(
      payload.checks[0].steps[1].evidence.ciWiring.inheritedEnv.ACCESS_TOKEN,
      '<redacted>'
    )
    for (const secret of [
      'payload-step-secret',
      'payload-command-secret',
      'payload-flag-secret',
      'payload-env-secret',
      'payload-output-secret',
      'payload-inherited-secret',
      'payload-bearer-secret',
    ]) {
      assert.doesNotMatch(serializedPayload, new RegExp(secret))
    }
  })

  it('includes custom Jest runner evidence for missing per-test events', () => {
    const [{ payload }] = buildValidationPayloads({
      manifest: {
        frameworks: [
          {
            id: 'jest:root',
            framework: 'jest',
            frameworkVersion: '30.4.2',
          },
        ],
      },
      results: [
        {
          frameworkId: 'jest:root',
          scenario: 'basic-reporting',
          status: 'fail',
          diagnosis: 'The selected Jest command uses the custom test runner `jest-light-runner`.',
          evidence: {
            commandExitCode: 0,
            commandOutputSummary: ['1 passed'],
            testSessionEvents: 1,
            testModuleEvents: 1,
            testSuiteEvents: 0,
            testEvents: 0,
            eventLevelFailure: {
              kind: 'custom-jest-runner',
              missingLevels: ['test_suite_end', 'test'],
              customTestRunner: {
                name: 'jest-light-runner',
                source: '/repo/jest.config.ts',
                sourceType: 'config',
                signals: [
                  'Jest config /repo/jest.config.ts sets runner: jest-light-runner',
                ],
              },
              summary: 'The selected Jest command uses the custom test runner `jest-light-runner`.',
              recommendation: 'Try a standard Jest runner command for validation.',
            },
          },
          artifacts: [],
        },
      ],
      artifacts: {
        reportPath: '/tmp/report.md',
      },
    })

    assert.deepStrictEqual(payload.checks[0].steps[1].evidence.eventLevelFailure.customTestRunner, {
      name: 'jest-light-runner',
      source: '/repo/jest.config.ts',
      sourceType: 'config',
      signals: [
        'Jest config /repo/jest.config.ts sets runner: jest-light-runner',
      ],
    })
  })

  it('does not emit live-run steps when no validation command was available', () => {
    const diagnosis = 'cypress was detected, but no runnable validation command was available.'
    const [{ payload }] = buildValidationPayloads({
      manifest: {
        frameworks: [
          {
            id: 'cypress:root',
            framework: 'cypress',
            frameworkVersion: '14.5.4',
          },
        ],
      },
      results: [
        {
          frameworkId: 'cypress:root',
          scenario: 'all',
          status: 'skip',
          diagnosis,
          evidence: {
            frameworkStatus: 'requires_manual_setup',
          },
          artifacts: [],
        },
      ],
      artifacts: {
        reportPath: '/tmp/report.md',
      },
    })

    assert.strictEqual(payload.status, 'unknown')
    assert.deepStrictEqual(payload.checks, [
      {
        id: 'basic-reporting',
        name: 'Basic reporting',
        status: 'skipped',
        reason: diagnosis,
        steps: [],
      },
    ])
  })
})
