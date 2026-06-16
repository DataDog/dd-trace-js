'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const zlib = require('node:zlib')

const { afterEach, beforeEach, describe, it } = require('mocha')

const { encode } = require('../../src/msgpack')
const {
  analyzeIntakeArtifact,
  buildKnownTestsFromArtifact,
  buildTestManagementTestsFromArtifact,
  renderAnalysisText,
} = require('../../../../ci/test-optimization-intake-analysis')
const {
  normalizeKnownTests,
  normalizeTestManagementTests,
  parseArgs,
  startIntake,
  stopIntake,
} = require('../../../../ci/test-optimization-intake')
const {
  getEfdExecutionDiagnostics,
  renderFeedbackSummary,
  renderFinalReport,
  renderSummaryReport,
} = require('../../../../ci/test-optimization-render-report')
const {
  buildCombinedValidationPayload,
  buildStaticValidationPayload,
} = require('../../../../ci/test-optimization-validation-link')
const {
  assertAdvancedPlanMatchesSelectedFiles,
  getNodeOptions,
  getTestResult,
  parseArgs: parseDebugArgs,
  prefixEnvForCommand,
  runDebug,
  runFullValidation,
} = require('../../../../ci/test-optimization-debug')
const {
  addTestFileToCommand,
  addRunInBandToCommand,
  getAtrBaselinePlan,
  getTemporaryEfdTestFile,
  getTemporaryTestSource,
  inferPrepareOptions,
  insertFlakyFailure,
  prepareAtrBaselineCandidate,
  prepareAdvancedChecks,
  restoreAdvancedChecks,
} = require('../../../../ci/test-optimization-prepare-advanced')
const {
  buildTestManagementResponse,
  createTestManagementCandidate,
  getProperties: getTestManagementProperties,
  inferTestManagementPlan,
  restoreTestManagementChecks,
  writeAutoTestManagementPlan,
} = require('../../../../ci/test-optimization-prepare-test-management')
const {
  buildTestCommand,
  detectFramework,
  selectTestCommand,
  writeSelection,
} = require('../../../../ci/test-optimization-select-command')
const {
  cleanArtifacts: cleanFeedbackRunnerArtifacts,
  isDiagnosticStatusLine,
  getScriptSummary,
  parseArgs: parseFeedbackRunnerArgs,
} = require('../../../../ci/test-optimization-feedback-runner')
const {
  isDiagnosticStatusLine: isFeedbackSummaryDiagnosticStatusLine,
  parseArgs: parseFeedbackSummaryArgs,
  renderFeedbackSummaryOutput,
} = require('../../../../ci/test-optimization-feedback-summary')

describe('Test Optimization debug intake', () => {
  let tmpDir
  let intake

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-testopt-intake-'))
  })

  afterEach((done) => {
    if (!intake) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      done()
      return
    }

    stopIntake(intake, () => {
      intake = undefined
      fs.rmSync(tmpDir, { recursive: true, force: true })
      done()
    })
  })

  it('reports the Nothing stage when no requests were received', () => {
    const analysis = analyzeIntakeArtifact({ requests: [] })

    assert.strictEqual(analysis.primaryStage, 'Nothing')
    assert.deepStrictEqual(analysis.findings[0], {
      status: 'error',
      stage: 'Nothing',
      observation: 'anyRequestReceived: false',
      cause:
        'The tracer was not loaded into the test process, the tracer was not pointed at the intake, or tests ' +
        'did not run.',
      fix:
        'Check NODE_OPTIONS="-r dd-trace/ci/init" reached the test process. Cypress and Playwright may need ' +
        'framework-specific wiring. Confirm the command actually selected and executed tests.',
    })
  })

  it('reports empty git metadata and missing session spans after settings', () => {
    const analysis = analyzeIntakeArtifact({
      requests: [
        {
          category: 'settings',
          path: '/api/v2/libraries/tests/services/setting',
          payload: {
            data: {
              attributes: {
                repository_url: '',
                sha: '',
                branch: '',
              },
            },
          },
        },
      ],
      settings: {
        responses: [
          {
            code_coverage: true,
            itr_enabled: true,
          },
        ],
      },
    })

    assert.ok(hasFinding(analysis, 'Settings, empty git'))
    assert.ok(hasFinding(analysis, 'No session spans'))
    assert.ok(!hasFinding(analysis, 'Coverage missing'))
  })

  it('reports missing test event levels', () => {
    const analysis = analyzeIntakeArtifact({
      requests: [
        {
          category: 'citestcycle',
          path: '/api/v2/citestcycle',
          payload: {
            events: [
              {
                type: 'test_session_end',
                content: {
                  test_session_id: 123n,
                },
              },
              {
                type: 'test',
                content: {
                  test_session_id: 123n,
                },
              },
            ],
          },
        },
      ],
    })

    assert.strictEqual(analysis.primaryStage, 'Incomplete test event levels')
    assert.deepStrictEqual(analysis.summary.events.missingLevels, ['test_module_end', 'test_suite_end'])
    assert.ok(hasFinding(analysis, 'Incomplete test event levels'))
  })

  it('builds known tests from captured test events', () => {
    const knownTests = buildKnownTestsFromArtifact({
      requests: [
        {
          category: 'citestcycle',
          payload: {
            events: [
              getTestEvent({
                framework: 'mocha',
                name: 'adds numbers',
                suite: 'test/sum.spec.js',
              }),
              getTestEvent({
                framework: 'mocha',
                name: 'subtracts numbers',
                suite: 'test/sum.spec.js',
              }),
              getTestEvent({
                framework: 'mocha',
                name: 'adds numbers',
                suite: 'test/sum.spec.js',
              }),
            ],
          },
        },
      ],
    })

    assert.deepStrictEqual(knownTests, {
      mocha: {
        'test/sum.spec.js': ['adds numbers', 'subtracts numbers'],
      },
    })
  })

  it('reports EFD retry evidence for a new test', () => {
    const analysis = analyzeIntakeArtifact({
      intake: {
        settingsMode: 'efd',
      },
      requests: [
        {
          category: 'settings',
          payload: {
            data: {
              attributes: {
                repository_url: 'git@example.com:org/repo.git',
                sha: 'abcdef',
                branch: 'main',
              },
            },
          },
        },
        {
          category: 'known_tests',
        },
        {
          category: 'citestcycle',
          payload: {
            events: [
              {
                type: 'test_session_end',
                content: {
                  test_session_id: 123n,
                },
              },
              {
                type: 'test_module_end',
                content: {
                  test_session_id: 123n,
                },
              },
              {
                type: 'test_suite_end',
                content: {
                  test_session_id: 123n,
                },
              },
              getTestEvent({
                framework: 'mocha',
                isNew: true,
                isRetry: true,
                name: 'new efd test',
                suite: 'test/sum.spec.js',
              }),
            ],
          },
        },
      ],
      settings: {
        responses: [
          {
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': 3,
              },
            },
            known_tests_enabled: true,
          },
        ],
      },
      knownTests: {
        responses: [
          {
            data: {
              attributes: {
                tests: {
                  mocha: {
                    'test/sum.spec.js': ['adds numbers'],
                  },
                },
              },
            },
          },
        ],
      },
    })

    assert.strictEqual(analysis.primaryStage, 'EFD retried new test')
    assert.strictEqual(analysis.summary.efd.knownTestsReceived, 1)
    assert.strictEqual(analysis.summary.efd.newTests.length, 1)
    assert.strictEqual(analysis.summary.efd.retriedNewTests, 1)
    assert.deepStrictEqual(analysis.summary.efd.retriedNewTestNames, ['new efd test'])
    assert.ok(hasFinding(analysis, 'EFD retried new test'))
  })

  it('reports Auto Test Retries evidence for a flaky known test', () => {
    const analysis = analyzeIntakeArtifact({
      intake: {
        settingsMode: 'atr',
      },
      requests: [
        {
          category: 'settings',
          payload: {
            data: {
              attributes: {
                repository_url: 'git@example.com:org/repo.git',
                sha: 'abcdef',
                branch: 'main',
              },
            },
          },
        },
        {
          category: 'citestcycle',
          payload: {
            events: [
              {
                type: 'test_session_end',
                content: {
                  test_session_id: 123n,
                },
              },
              {
                type: 'test_module_end',
                content: {
                  test_session_id: 123n,
                },
              },
              {
                type: 'test_suite_end',
                content: {
                  test_session_id: 123n,
                },
              },
              getTestEvent({
                framework: 'mocha',
                name: 'already known test',
                status: 'fail',
                suite: 'test/sum.spec.js',
              }),
              getTestEvent({
                framework: 'mocha',
                isRetry: true,
                name: 'already known test',
                retryReason: 'auto_test_retry',
                status: 'pass',
                suite: 'test/sum.spec.js',
              }),
            ],
          },
        },
      ],
      settings: {
        responses: [
          {
            flaky_test_retries_enabled: true,
            flaky_test_retries_count: 1,
            early_flake_detection: {
              enabled: false,
            },
          },
        ],
      },
    })

    assert.strictEqual(analysis.primaryStage, 'Auto test retry reported flaky test')
    assert.strictEqual(analysis.summary.atr.settingsEnabled, true)
    assert.strictEqual(analysis.summary.atr.failedExecutions, 1)
    assert.strictEqual(analysis.summary.atr.passedExecutions, 1)
    assert.strictEqual(analysis.summary.atr.passedRetryTests, 1)
    assert.strictEqual(analysis.summary.atr.failedThenPassedRetryTests, 1)
    assert.deepStrictEqual(analysis.summary.atr.failedThenPassedRetryTestNames, ['already known test'])
    assert.ok(hasFinding(analysis, 'Auto test retry reported flaky test'))
  })

  it('builds Test Management modules from captured test events', () => {
    const result = buildTestManagementTestsFromArtifact({
      requests: [
        {
          category: 'citestcycle',
          payload: {
            events: [
              getTestEvent({
                framework: 'mocha',
                name: 'dd trace test management debug dd trace test management disabled candidate',
                suite: 'test/dd-trace-tm-disabled.spec.js',
              }),
            ],
          },
        },
      ],
    }, {
      attempt_to_fix: false,
      disabled: true,
      quarantined: false,
    }, {
      testName: 'dd trace test management disabled candidate',
    })

    assert.deepStrictEqual(result.modules, {
      mocha: {
        suites: {
          'test/dd-trace-tm-disabled.spec.js': {
            tests: {
              'dd trace test management debug dd trace test management disabled candidate': {
                properties: {
                  attempt_to_fix: false,
                  disabled: true,
                  quarantined: false,
                },
              },
            },
          },
        },
      },
    })
    assert.strictEqual(result.identity.framework, 'mocha')
  })

  it('reports Test Management disabled evidence', () => {
    const analysis = analyzeIntakeArtifact(getTestManagementArtifact({
      mode: 'tm-disabled',
      properties: {
        attempt_to_fix: false,
        disabled: true,
        quarantined: false,
      },
      testEvents: [
        getTestEvent({
          finalStatus: 'skip',
          framework: 'mocha',
          name: 'disabled candidate',
          status: 'skip',
          suite: 'test/dd-trace-tm-disabled.spec.js',
          testManagement: {
            disabled: true,
          },
        }),
      ],
    }))

    assert.strictEqual(analysis.primaryStage, 'Test Management disabled reported')
    assert.strictEqual(analysis.summary.tm.settingsEnabled, true)
    assert.strictEqual(analysis.summary.tm.propertiesEndpointCalled, true)
    assert.strictEqual(analysis.summary.tm.returnedProperties, 1)
    assert.strictEqual(analysis.summary.tm.disabled.status, 'passed')
    assert.deepStrictEqual(analysis.summary.tm.disabled.observedFinalStatuses, ['skip'])
    assert.ok(hasFinding(analysis, 'Test Management disabled reported'))
    assert.match(renderAnalysisText(analysis), /Test Management disabled status: passed/)
  })

  it('reports Test Management quarantined evidence', () => {
    const analysis = analyzeIntakeArtifact(getTestManagementArtifact({
      mode: 'tm-quarantined',
      properties: {
        attempt_to_fix: false,
        disabled: false,
        quarantined: true,
      },
      testEvents: [
        getTestEvent({
          finalStatus: 'skip',
          framework: 'mocha',
          name: 'quarantined candidate',
          status: 'fail',
          suite: 'test/dd-trace-tm-quarantined.spec.js',
          testManagement: {
            quarantined: true,
          },
        }),
      ],
    }))

    assert.strictEqual(analysis.primaryStage, 'Test Management quarantined reported')
    assert.strictEqual(analysis.summary.tm.quarantined.status, 'passed')
    assert.deepStrictEqual(analysis.summary.tm.quarantined.observedStatuses, ['fail'])
  })

  it('reports Test Management attempt-to-fix evidence', () => {
    const analysis = analyzeIntakeArtifact(getTestManagementArtifact({
      mode: 'tm-attempt-to-fix',
      properties: {
        attempt_to_fix: true,
        disabled: false,
        quarantined: false,
      },
      testEvents: [
        getTestEvent({
          framework: 'mocha',
          name: 'attempt candidate',
          status: 'pass',
          suite: 'test/dd-trace-tm-attempt-to-fix.spec.js',
          testManagement: {
            attemptToFix: true,
          },
        }),
        getTestEvent({
          finalStatus: 'fail',
          framework: 'mocha',
          isRetry: true,
          name: 'attempt candidate',
          retryReason: 'attempt_to_fix',
          status: 'fail',
          suite: 'test/dd-trace-tm-attempt-to-fix.spec.js',
          testManagement: {
            attemptToFix: true,
            attemptToFixPassed: false,
          },
        }),
      ],
    }))

    assert.strictEqual(analysis.primaryStage, 'Test Management attempt-to-fix reported')
    assert.strictEqual(analysis.summary.tm.attemptToFix.status, 'passed')
    assert.strictEqual(analysis.summary.tm.attemptToFix.attemptToFixRetryExecutions, 1)
    assert.deepStrictEqual(analysis.summary.tm.attemptToFix.badRetryReasons, [])
    assert.deepStrictEqual(analysis.summary.tm.attemptToFix.observedRetryReasons, ['attempt_to_fix'])
  })

  it('reports Test Management identity mismatches before subcheck status', () => {
    const analysis = analyzeIntakeArtifact(getTestManagementArtifact({
      mode: 'tm-disabled',
      properties: {
        attempt_to_fix: false,
        disabled: true,
        quarantined: false,
      },
      propertyName: 'different candidate',
      testEvents: [
        getTestEvent({
          finalStatus: 'skip',
          framework: 'mocha',
          name: 'disabled candidate',
          status: 'skip',
          suite: 'test/dd-trace-tm-disabled.spec.js',
          testManagement: {
            disabled: true,
          },
        }),
      ],
    }))

    assert.strictEqual(analysis.primaryStage, 'Test Management identity mismatch')
    assert.strictEqual(analysis.summary.tm.unmatchedPropertyIdentities.length, 1)
  })

  it('serves configured EFD settings and known tests', (done) => {
    const knownTests = {
      mocha: {
        'test/sum.spec.js': ['adds numbers'],
      },
    }

    startIntake({
      knownTests,
      out: path.join(tmpDir, 'intake.json'),
      settingsMode: 'efd',
    }, (error, startedIntake) => {
      assert.ifError(error)
      intake = startedIntake

      postJsonResponse(intake.url, '/api/v2/libraries/tests/services/setting', {}, (settingsError, settings) => {
        assert.ifError(settingsError)
        assert.strictEqual(settings.data.attributes.known_tests_enabled, true)
        assert.strictEqual(settings.data.attributes.early_flake_detection.enabled, true)

        postJsonResponse(intake.url, '/api/v2/ci/libraries/tests', {}, (knownTestsError, response) => {
          assert.ifError(knownTestsError)
          assert.deepStrictEqual(response.data.attributes.tests, knownTests)
          done()
        })
      })
    })
  })

  it('serves configured Test Management settings and properties', (done) => {
    const modules = {
      mocha: {
        suites: {
          'test/sum.spec.js': {
            tests: {
              'sum adds numbers': {
                properties: {
                  attempt_to_fix: false,
                  disabled: true,
                  quarantined: false,
                },
              },
            },
          },
        },
      },
    }

    startIntake({
      out: path.join(tmpDir, 'intake.json'),
      settingsMode: 'tm-disabled',
      testManagementTests: modules,
    }, (error, startedIntake) => {
      assert.ifError(error)
      intake = startedIntake

      postJsonResponse(intake.url, '/api/v2/libraries/tests/services/setting', {}, (settingsError, settings) => {
        assert.ifError(settingsError)
        assert.strictEqual(settings.data.attributes.test_management.enabled, true)
        assert.strictEqual(settings.data.attributes.test_management.attempt_to_fix_retries, 3)
        assert.strictEqual(settings.data.attributes.early_flake_detection.enabled, false)
        assert.strictEqual(settings.data.attributes.flaky_test_retries_enabled, false)

        postJsonResponse(
          intake.url,
          '/api/v2/test/libraries/test-management/tests',
          { data: { attributes: { repository_url: 'git@example.com:org/repo.git' } } },
          (testManagementError, response) => {
            assert.ifError(testManagementError)
            assert.deepStrictEqual(response.data.attributes.modules, modules)
            assert.strictEqual(intake.artifact.testManagement.responses.length, 1)
            assert.strictEqual(
              intake.artifact.testManagement.responses[0].request.data.attributes.repository_url,
              'git@example.com:org/repo.git'
            )
            done()
          }
        )
      })
    })
  })

  it('normalizes known tests endpoint response files', () => {
    assert.deepStrictEqual(normalizeKnownTests({
      data: {
        attributes: {
          tests: {
            mocha: {
              'test/sum.spec.js': ['adds numbers'],
            },
          },
        },
      },
    }), {
      mocha: {
        'test/sum.spec.js': ['adds numbers'],
      },
    })
  })

  it('normalizes Test Management endpoint response files', () => {
    const modules = {
      mocha: {
        suites: {
          'test/sum.spec.js': {
            tests: {
              'sum adds numbers': {
                properties: {
                  disabled: true,
                },
              },
            },
          },
        },
      },
    }

    assert.deepStrictEqual(normalizeTestManagementTests({
      data: {
        attributes: {
          modules,
        },
      },
    }), modules)
    assert.deepStrictEqual(normalizeTestManagementTests({ modules }), modules)
    assert.deepStrictEqual(normalizeTestManagementTests(modules), modules)
  })

  it('records and analyzes decoded citestcycle payloads', (done) => {
    startIntake({ out: path.join(tmpDir, 'intake.json') }, (error, startedIntake) => {
      assert.ifError(error)
      intake = startedIntake

      postJson(intake.url, '/api/v2/libraries/tests/services/setting', {
        data: {
          attributes: {
            repository_url: 'git@example.com:org/repo.git',
            sha: 'abcdef',
            branch: 'main',
          },
        },
      }, (settingsError) => {
        assert.ifError(settingsError)

        const payload = encode({
          events: [
            {
              type: 'test_session_end',
              content: {
                test_session_id: '123',
              },
            },
            {
              type: 'test_module_end',
              content: {
                test_session_id: '123',
              },
            },
            {
              type: 'test_suite_end',
              content: {
                test_session_id: '123',
              },
            },
            {
              type: 'test',
              content: {
                test_session_id: 123n,
              },
            },
          ],
          metadata: [],
        })

        postBuffer(intake.url, '/api/v2/citestcycle', payload, {
          'Content-Type': 'application/msgpack',
        }, (postError) => {
          assert.ifError(postError)

          const analysis = analyzeIntakeArtifact(intake.artifact)
          assert.strictEqual(analysis.primaryStage, 'Reporting complete')
          assert.strictEqual(analysis.summary.citestcycle.payloadCount, 1)
          assert.strictEqual(analysis.summary.events.counts.test_session_end, 1)
          assert.strictEqual(analysis.summary.events.counts.test_module_end, 1)
          assert.strictEqual(analysis.summary.events.counts.test_suite_end, 1)
          assert.strictEqual(analysis.summary.events.counts.test, 1)
          assert.deepStrictEqual(analysis.summary.events.missingLevels, [])
          assert.strictEqual(analysis.summary.artifacts.htmlPath, intake.html)
          const analysisText = renderAnalysisText(analysis)
          assert.match(
            analysisText,
            new RegExp(`^HTML report: ${escapeRegExp(pathToFileURL(intake.html).href)}\\n`)
          )
          assert.match(analysisText, new RegExp(`\\nHTML report path: ${escapeRegExp(intake.html)}\\n`))
          assert.match(analysisText, /test event levels: sessions=1, modules=1, suites=1, tests=1/)
          assert.match(analysisText, /\nOpen HTML report command: /)
          assert.match(analysisText, /\nDatadog validation: ci\/test\/validation#pako:/)

          const validationPayload = getValidationPayload(analysisText)
          const basicCheck = validationPayload.checks.find(check => check.id === 'basic-reporting')
          const eventsStep = basicCheck.steps.find(step => step.id === 'check-events')

          assert.strictEqual(validationPayload.version, 2)
          assert.strictEqual(validationPayload.status, 'ok')
          assert.strictEqual(validationPayload.summary, undefined)
          assert.strictEqual(validationPayload.static, undefined)
          assert.strictEqual(validationPayload.env, undefined)
          assert.strictEqual(basicCheck.status, 'ok')
          assert.strictEqual(eventsStep.status, 'ok')
          assert.strictEqual(eventsStep.evidence.requestCount, 2)
          assert.strictEqual(eventsStep.evidence.citestcyclePayloads, 1)
          assert.strictEqual(eventsStep.evidence.events.tests, 1)

          const report = fs.readFileSync(intake.html, 'utf8')
          assert.match(report, /Test Optimization debug report/)
          assert.match(report, /Reporting complete/)
          assert.match(report, /<style>/)
          assert.doesNotMatch(report, /<script/)
          assert.doesNotMatch(report, /\b(?:href|src)=/)
          done()
        })
      })
    })
  })

  it('stops and flushes artifacts through the shutdown URL', (done) => {
    startIntake({ out: path.join(tmpDir, 'intake.json') }, (error, startedIntake) => {
      assert.ifError(error)
      intake = startedIntake

      let closed = false
      let responseReceived = false
      let shutdownResponse
      intake.server.once('close', () => {
        closed = true
        maybeFinishShutdownTest()
      })

      getJson(intake.shutdownUrl, (shutdownError, statusCode, payload) => {
        try {
          assert.ifError(shutdownError)
          assert.strictEqual(statusCode, 200)
          shutdownResponse = payload
          responseReceived = true
          maybeFinishShutdownTest()
        } catch (assertionError) {
          done(assertionError)
        }
      })

      function maybeFinishShutdownTest () {
        if (!closed || !responseReceived) return

        try {
          assert.deepStrictEqual(shutdownResponse, {
            artifact: intake.out,
            htmlFileUrl: pathToFileURL(intake.html).href,
            htmlOpenCommand: getExpectedOpenCommand(intake.html),
            html: intake.html,
            ok: true,
          })

          const artifact = JSON.parse(fs.readFileSync(intake.out, 'utf8'))
          assert.match(artifact.intake.stoppedAt, /^\d{4}-\d{2}-\d{2}T/)
          assert.strictEqual(artifact.intake.htmlReportFileUrl, pathToFileURL(intake.html).href)
          assert.strictEqual(artifact.intake.htmlReportOpenCommand, getExpectedOpenCommand(intake.html))

          intake = undefined
          done()
        } catch (assertionError) {
          done(assertionError)
        }
      }
    })
  })

  it('parses the HTML report path', () => {
    assert.deepStrictEqual(parseArgs(['--html', 'report.html']).html, 'report.html')
    assert.deepStrictEqual(parseArgs(['--html=report.html']).html, 'report.html')
  })

  it('parses standalone intake Test Management arguments', () => {
    const testManagementTestsPath = path.join(tmpDir, 'test-management-tests.json')
    const testManagementTests = {
      mocha: {
        suites: {
          'test/sum.spec.js': {
            tests: {
              'sum adds numbers': {
                properties: {
                  disabled: true,
                },
              },
            },
          },
        },
      },
    }

    fs.writeFileSync(
      testManagementTestsPath,
      JSON.stringify({ data: { attributes: { modules: testManagementTests } } })
    )

    assert.deepStrictEqual(parseArgs([
      '--settings-mode',
      'tm-disabled',
      '--test-management-tests',
      testManagementTestsPath,
    ]).testManagementTests, testManagementTests)
  })

  it('parses debug wrapper arguments', () => {
    const knownTestsPath = path.join(tmpDir, 'known-tests.json')
    const testManagementTestsPath = path.join(tmpDir, 'test-management-tests.json')
    const knownTests = {
      mocha: {
        'test/sum.spec.js': ['adds numbers'],
      },
    }
    const testManagementTests = {
      mocha: {
        suites: {
          'test/sum.spec.js': {
            tests: {
              'sum adds numbers': {
                properties: {
                  disabled: true,
                },
              },
            },
          },
        },
      },
    }

    fs.writeFileSync(knownTestsPath, JSON.stringify({ data: { attributes: { tests: knownTests } } }))
    fs.writeFileSync(
      testManagementTestsPath,
      JSON.stringify({ data: { attributes: { modules: testManagementTests } } })
    )

    assert.deepStrictEqual(parseDebugArgs([
      '--test-command',
      'npm test -- test/sum.spec.js',
      '--test-command-file',
      'dd-test-optimization-test-command.txt',
      '--service=ci-debug',
      '--out-dir',
      tmpDir,
      '--ready-timeout-ms=1234',
      '--settings-mode=efd',
      '--known-tests',
      knownTestsPath,
      '--test-management-tests',
      testManagementTestsPath,
      '--new-test-snippet-file',
      'dd-test-optimization-efd-new-test-snippet.txt',
      '--flaky-test-snippet-file',
      'dd-test-optimization-atr-flaky-test-snippet.txt',
      '--no-clean',
      '--no-open',
      '--full',
      '--tm-all',
      '--framework=jest',
      '--package-root',
      'packages/example',
      '--preflight',
      '--force-run-in-band',
    ]), {
      clean: false,
      forceRunInBand: true,
      framework: 'jest',
      full: true,
      flakyTestSnippetFile: 'dd-test-optimization-atr-flaky-test-snippet.txt',
      knownTests,
      open: false,
      outDir: tmpDir,
      newTestSnippetFile: 'dd-test-optimization-efd-new-test-snippet.txt',
      packageRoot: 'packages/example',
      preflight: true,
      readyTimeoutMs: 1234,
      service: 'ci-debug',
      settingsMode: 'efd',
      testCommand: 'npm test -- test/sum.spec.js',
      testCommandFile: 'dd-test-optimization-test-command.txt',
      testManagementTests,
      tmAll: true,
    })
  })

  it('parses feedback-mode wrapper arguments', () => {
    assert.deepStrictEqual(parseDebugArgs([
      '--feedback-mode',
      '--test-command-file',
      'dd-test-optimization-test-command.txt',
      '--selected-test-files-file=dd-test-optimization-selected-test-files.txt',
      '--no-open',
    ]), {
      clean: true,
      feedbackMode: true,
      open: false,
      selectedTestFilesFile: 'dd-test-optimization-selected-test-files.txt',
      service: 'dd-test-optimization-debug',
      testCommandFile: 'dd-test-optimization-test-command.txt',
    })
  })

  it('parses feedback runner arguments', () => {
    assert.deepStrictEqual(parseFeedbackRunnerArgs(['--framework=jest']), {
      framework: 'jest',
    })
    assert.deepStrictEqual(parseFeedbackRunnerArgs(['--framework', 'mocha']), {
      framework: 'mocha',
    })
  })

  it('filters feedback runner diagnostic status lines', () => {
    assert.strictEqual(isDiagnosticStatusLine('?? dd-test-optimization-report.html'), true)
    assert.strictEqual(isDiagnosticStatusLine('?? dd-intake-url.txt'), true)
    assert.strictEqual(isDiagnosticStatusLine(' M dd-test-optimization-final-report.txt'), true)
    assert.strictEqual(isDiagnosticStatusLine('?? nohup.out'), true)
    assert.strictEqual(isDiagnosticStatusLine(' M package.json'), false)
    assert.strictEqual(isDiagnosticStatusLine('?? unrelated.txt'), false)
  })

  it('parses feedback summary arguments', () => {
    assert.deepStrictEqual(parseFeedbackSummaryArgs([
      '--feedback-file=feedback.txt',
      '--out',
      'summary.txt',
      '--preexisting-status-file',
      'status.txt',
    ]), {
      feedbackFile: 'feedback.txt',
      feedbackSummaryOut: 'summary.txt',
      preexistingStatusFile: 'status.txt',
    })
  })

  it('filters feedback summary diagnostic status lines', () => {
    assert.strictEqual(isFeedbackSummaryDiagnosticStatusLine('?? dd-test-optimization-report.html'), true)
    assert.strictEqual(isFeedbackSummaryDiagnosticStatusLine('?? dd-intake-url.txt'), true)
    assert.strictEqual(isFeedbackSummaryDiagnosticStatusLine(' M dd-test-optimization-final-report.txt'), true)
    assert.strictEqual(isFeedbackSummaryDiagnosticStatusLine('?? nohup.out'), true)
    assert.strictEqual(isFeedbackSummaryDiagnosticStatusLine(' M package.json'), false)
    assert.strictEqual(isFeedbackSummaryDiagnosticStatusLine('?? unrelated.txt'), false)
  })

  it('summarizes package scripts for feedback runner discovery output', () => {
    assert.deepStrictEqual(getScriptSummary({
      build: 'tsc',
      lint: 'eslint .',
      test: 'jest',
      'test:debug': 'jest --runInBand',
    }), {
      count: 4,
      test: 'jest',
      testScripts: ['test', 'test:debug'],
    })
  })

  it('cleans feedback runner artifacts without removing preexisting status', () => {
    const cwd = process.cwd()
    const artifact = path.join(tmpDir, 'dd-test-optimization-agent-report.json')
    const directory = path.join(tmpDir, 'dd-test-optimization-basic')
    const preexistingStatus = path.join(tmpDir, 'dd-test-optimization-preexisting-status.txt')

    fs.writeFileSync(artifact, '{}\n')
    fs.mkdirSync(directory)
    fs.writeFileSync(path.join(directory, 'nested.txt'), 'nested\n')
    fs.writeFileSync(preexistingStatus, ' M package.json\n')
    process.chdir(tmpDir)

    try {
      cleanFeedbackRunnerArtifacts()

      assert.strictEqual(fs.existsSync(artifact), false)
      assert.strictEqual(fs.existsSync(directory), false)
      assert.strictEqual(fs.readFileSync(preexistingStatus, 'utf8'), ' M package.json\n')
    } finally {
      process.chdir(cwd)
    }
  })

  it('matches advanced dry-run targets against newline-selected files', () => {
    assertAdvancedPlanMatchesSelectedFiles({
      efdTestFile: 'test path/dd-trace-efd-debug.test.js',
      flakyTestFile: 'test path/sum.spec.js',
    }, ['test path/sum.spec.js'])

    assert.throws(() => {
      assertAdvancedPlanMatchesSelectedFiles({
        efdTestFile: 'other/dd-trace-efd-debug.test.js',
        flakyTestFile: 'test path/sum.spec.js',
      }, ['test path/sum.spec.js'])
    }, /Temporary EFD file is not under a selected test directory/)

    assert.throws(() => {
      assertAdvancedPlanMatchesSelectedFiles({
        efdTestFile: 'test path/dd-trace-efd-debug.test.js',
        flakyTestFile: 'test path/other.spec.js',
      }, ['test path/sum.spec.js'])
    }, /Auto Test Retries flaky file is not one of the selected test files/)
  })

  it('builds NODE_OPTIONS for regular and Vitest test processes', () => {
    const cwd = process.cwd()
    const nodeOptions = process.env.NODE_OPTIONS
    process.env.NODE_OPTIONS = '--loader existing-loader'

    try {
      assert.strictEqual(
        getNodeOptions({ supportedFrameworks: [{ id: 'mocha' }] }),
        '--loader existing-loader -r dd-trace/ci/init'
      )
      assert.strictEqual(
        getNodeOptions({ supportedFrameworks: [{ id: 'vitest' }] }),
        '--loader existing-loader --import dd-trace/register.js -r dd-trace/ci/init'
      )
      assert.strictEqual(
        getNodeOptions(
          { supportedFrameworks: [{ id: 'mocha' }, { id: 'vitest' }] },
          'npm test -- test/foo.spec.js'
        ),
        '--loader existing-loader -r dd-trace/ci/init'
      )
      assert.strictEqual(
        getNodeOptions(
          { supportedFrameworks: [{ id: 'mocha' }, { id: 'vitest' }] },
          './node_modules/.bin/vitest test/foo.spec.js'
        ),
        '--loader existing-loader --import dd-trace/register.js -r dd-trace/ci/init'
      )

      process.chdir(tmpDir)
      fs.writeFileSync(path.join(tmpDir, '.pnp.cjs'), '')

      const pnpPath = path.resolve('.pnp.cjs')
      assert.strictEqual(
        getNodeOptions({ supportedFrameworks: [{ id: 'mocha' }] }),
        `--loader existing-loader -r ${pnpPath} -r ${path.join(cwd, 'ci/init.js')}`
      )
    } finally {
      process.chdir(cwd)
      if (nodeOptions === undefined) {
        delete process.env.NODE_OPTIONS
      } else {
        process.env.NODE_OPTIONS = nodeOptions
      }
    }
  })

  it('extracts a deterministic one-line test result', () => {
    assert.strictEqual(getTestResult('\n  2 passing (4ms)\n'), '2 passing (4ms)')
    assert.strictEqual(getTestResult([
      '\u001b[1mTest Suites: \u001b[22m\u001b[1m\u001b[32m1 passed\u001b[39m\u001b[22m, 1 total',
      '\u001b[1mTests:       \u001b[22m\u001b[1m\u001b[32m16 passed\u001b[39m\u001b[22m, 16 total',
    ].join('\n')), '16 tests passed (1 suite passed)')
    assert.strictEqual(getTestResult([
      'Test Suites: 1 failed, 2 passed, 3 total',
      'Tests:       4 failed, 8 passed, 12 total',
    ].join('\n')), '4 tests failed, 8 tests passed (1 suite failed, 2 suites passed)')
    assert.strictEqual(getTestResult('no runner summary here\n'), 'unknown')
  })

  it('prefixes Test Management baseline env inside package-root commands', () => {
    assert.strictEqual(
      prefixEnvForCommand(
        'DD_TEST_OPTIMIZATION_TM_BASELINE=1',
        'cd scripts/codemods/ac3-to-ac4 && ../../../node_modules/.bin/vitest run src/__tests__/links.test.ts'
      ),
      'cd scripts/codemods/ac3-to-ac4 && DD_TEST_OPTIMIZATION_TM_BASELINE=1 ' +
        '../../../node_modules/.bin/vitest run src/__tests__/links.test.ts'
    )
    assert.strictEqual(
      prefixEnvForCommand('DD_TEST_OPTIMIZATION_TM_BASELINE=1', 'npm test -- test/sum.spec.js'),
      'DD_TEST_OPTIMIZATION_TM_BASELINE=1 npm test -- test/sum.spec.js'
    )
  })

  it('runs the debug wrapper and writes artifacts', (done) => {
    const testCommand = 'node report.js'
    const testCommandFile = path.join(tmpDir, 'selected-command.txt')
    const cwd = process.cwd()

    fs.mkdirSync(path.join(tmpDir, 'node_modules/dd-trace/ci'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      dependencies: {
        'dd-trace': '6.0.0-test',
      },
    }))
    fs.writeFileSync(path.join(tmpDir, 'node_modules/dd-trace/package.json'), JSON.stringify({
      version: '6.0.0-test',
    }))
    fs.writeFileSync(path.join(tmpDir, 'node_modules/dd-trace/ci/init.js'), '')
    fs.writeFileSync(testCommandFile, `${testCommand}\n`)
    fs.writeFileSync(path.join(tmpDir, 'report.js'), [
      'fetch(process.env.DD_CIVISIBILITY_AGENTLESS_URL + "/info")',
      '  .then(() => console.log("2 passing"))',
      '  .catch(error => {',
      '    console.error(error.message)',
      '    process.exitCode = 1',
      '  })',
      '',
    ].join('\n'))
    process.chdir(tmpDir)

    runDebug({
      clean: true,
      open: false,
      outDir: tmpDir,
      service: 'ci-debug',
      silent: true,
      testCommandFile,
    }, (error, report) => {
      try {
        process.chdir(cwd)
        assert.ifError(error)
        assert.match(report, /Primary funnel stage: Connected, no settings/)
        assert.match(report, /Summary:\n- Reporting: failed \(Connected, no settings\)/)
        const htmlReportPath = path.join(tmpDir, 'dd-test-optimization-report.html')

        assert.match(report, new RegExp(`HTML report: ${escapeRegExp(pathToFileURL(htmlReportPath).href)}`))
        assert.doesNotMatch(report, /HTML report path:/)
        assert.doesNotMatch(report, /Consistency checks:/)
        assert.doesNotMatch(report, /Env vars used/)
        assert.strictEqual(
          fs.readFileSync(path.join(tmpDir, 'dd-test-optimization-test-command.txt'), 'utf8'),
          `${testCommand}\n`
        )
        assert.strictEqual(
          fs.readFileSync(path.join(tmpDir, 'dd-test-optimization-test-result.txt'), 'utf8'),
          '2 passing\n'
        )
        assert.strictEqual(
          JSON.parse(fs.readFileSync(path.join(tmpDir, 'dd-test-optimization-intake.json'), 'utf8')).requests.length,
          1
        )
        const envFile = fs.readFileSync(path.join(tmpDir, 'dd-test-optimization-env.txt'), 'utf8')

        assert.match(
          envFile,
          /DD_API_KEY=debug\nDD_SERVICE=ci-debug\n/
        )
        assert.match(envFile, /DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED=true\n/)
        assert.match(envFile, /DD_CIVISIBILITY_ENABLED=true\n/)
        assert.match(envFile, /DD_CIVISIBILITY_FLAKY_RETRY_ENABLED=true\n/)
        assert.match(envFile, /DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE=false\n/)
        assert.match(envFile, /DD_TEST_MANAGEMENT_ENABLED=true\n/)
        assert.match(
          envFile,
          /NODE_OPTIONS=-r dd-trace\/ci\/init\n/
        )
        assert.ok(fs.existsSync(path.join(tmpDir, 'dd-test-optimization-final-report.txt')))
        assert.ok(fs.existsSync(path.join(tmpDir, 'dd-test-optimization-summary.txt')))
        assert.ok(fs.existsSync(path.join(tmpDir, 'dd-test-optimization-agent-report.json')))
        assert.strictEqual(
          JSON.parse(fs.readFileSync(path.join(tmpDir, 'dd-test-optimization-artifacts.json'), 'utf8'))
            .artifacts.artifactManifest.exists,
          true
        )
        done()
      } catch (assertionError) {
        process.chdir(cwd)
        done(assertionError)
      }
    })
  })

  it('prepares and restores advanced check temporary edits', () => {
    const cwd = process.cwd()
    const testFile = path.join(tmpDir, 'test/sum.spec.js')
    const efdTestFile = path.join(tmpDir, 'test/dd-trace-efd-debug.spec.js')
    const original = [
      'const assert = require(\'node:assert/strict\')',
      '',
      'describe(\'sum\', () => {',
      '  it(\'adds numbers\', () => {',
      '    assert.strictEqual(1 + 1, 2)',
      '  })',
      '})',
      '',
    ].join('\n')

    fs.mkdirSync(path.dirname(testFile), { recursive: true })
    fs.writeFileSync(testFile, original)
    process.chdir(tmpDir)

    try {
      prepareAdvancedChecks({
        efdCommand: 'npm test -- test/sum.spec.js test/dd-trace-efd-debug.spec.js',
        efdTestFile: 'test/dd-trace-efd-debug.spec.js',
        flakyTestFile: 'test/sum.spec.js',
        flakyTestName: 'adds numbers',
        framework: 'mocha',
      })

      assert.ok(fs.existsSync(efdTestFile))
      assert.match(fs.readFileSync(testFile, 'utf8'), /dd trace auto retry debug flake/)
      assert.match(
        fs.readFileSync('dd-test-optimization-atr-flaky-test-snippet.txt', 'utf8'),
        /it\('adds numbers'/
      )
      assert.strictEqual(
        fs.readFileSync('dd-test-optimization-efd-command.txt', 'utf8'),
        'npm test -- test/sum.spec.js test/dd-trace-efd-debug.spec.js\n'
      )
      assert.strictEqual(fs.readFileSync('dd-test-optimization-efd-test-name.txt', 'utf8'), [
        'dd trace EFD debug temporary test',
        '',
      ].join('\n'))
      assert.strictEqual(fs.readFileSync('dd-test-optimization-atr-flaky-test-name.txt', 'utf8'), [
        'adds numbers',
        '',
      ].join('\n'))
      const backup = fs.readFileSync('dd-test-optimization-atr-flaky-test-backup.txt', 'utf8').trim()
      assert.strictEqual(
        path.dirname(backup),
        path.join('dd-test-optimization-efd', 'backups')
      )

      restoreAdvancedChecks()

      const cleanup = JSON.parse(fs.readFileSync('dd-test-optimization-advanced-cleanup.json', 'utf8'))
      assert.strictEqual(cleanup.ok, true)
      assert.deepStrictEqual(cleanup.stateFilesRemaining, [])
      assert.ok(cleanup.paths.some(entry =>
        entry.path === 'test/dd-trace-efd-debug.spec.js' && entry.remaining === false
      ))
      assert.ok(cleanup.paths.some(entry =>
        entry.path === 'test/sum.spec.js' && entry.remaining === false
      ))
      assert.ok(cleanup.paths.some(entry =>
        entry.path === backup && entry.remaining === false
      ))
      assert.ok(!fs.existsSync(efdTestFile))
      assert.strictEqual(fs.readFileSync(testFile, 'utf8'), original)
      assert.ok(!fs.existsSync('dd-test-optimization-atr-flaky-test-file.txt'))
      assert.ok(!fs.existsSync('dd-test-optimization-atr-flaky-test-backup.txt'))
      assert.ok(!fs.existsSync('dd-test-optimization-efd-test-name.txt'))
      assert.ok(!fs.existsSync('dd-test-optimization-atr-flaky-test-name.txt'))
      assert.ok(!fs.existsSync(backup))
    } finally {
      process.chdir(cwd)
    }
  })

  it('prepares calibrated Test Management candidate files and responses', () => {
    const cwd = process.cwd()
    const testFile = path.join(tmpDir, 'test/dd-trace-tm-disabled.spec.js')

    process.chdir(tmpDir)

    try {
      createTestManagementCandidate({
        framework: 'mocha',
        mode: 'disabled',
        testFile: 'test/dd-trace-tm-disabled.spec.js',
      })

      assert.ok(fs.existsSync(testFile))
      assert.match(fs.readFileSync(testFile, 'utf8'), /DD_TEST_OPTIMIZATION_TM_BASELINE/)
      assert.match(fs.readFileSync(
        path.join('dd-test-optimization-test-management', 'candidate-snippet.txt'),
        'utf8'
      ), /dd trace test management disabled candidate/)
      assert.deepStrictEqual(getTestManagementProperties('attempt-to-fix'), {
        attempt_to_fix: true,
        disabled: false,
        quarantined: false,
      })

      fs.writeFileSync('baseline-intake.json', JSON.stringify({
        requests: [
          {
            category: 'citestcycle',
            payload: {
              events: [
                getTestEvent({
                  framework: 'mocha',
                  name: 'dd trace test management debug dd trace test management disabled candidate',
                  suite: 'test/dd-trace-tm-disabled.spec.js',
                }),
              ],
            },
          },
        ],
      }))

      buildTestManagementResponse({
        baselineIntake: 'baseline-intake.json',
        mode: 'disabled',
      })

      const response = JSON.parse(fs.readFileSync(
        path.join('dd-test-optimization-test-management', 'test-management-tests.json'),
        'utf8'
      ))

      assert.deepStrictEqual(
        response.data.attributes.modules.mocha.suites['test/dd-trace-tm-disabled.spec.js']
          .tests['dd trace test management debug dd trace test management disabled candidate'].properties,
        {
          attempt_to_fix: false,
          disabled: true,
          quarantined: false,
        }
      )

      restoreTestManagementChecks()

      const cleanup = JSON.parse(fs.readFileSync('dd-test-optimization-test-management-cleanup.json', 'utf8'))
      assert.strictEqual(cleanup.ok, true)
      assert.deepStrictEqual(cleanup.stateFilesRemaining, [])
      assert.ok(cleanup.paths.some(entry =>
        entry.path.endsWith('/test/dd-trace-tm-disabled.spec.js') && entry.remaining === false
      ))
      assert.ok(!fs.existsSync(testFile))
      assert.ok(!fs.existsSync(path.join('dd-test-optimization-test-management', 'generated-files.txt')))
    } finally {
      process.chdir(cwd)
    }
  })

  it('infers Test Management helper state from known-tests and selected-command artifacts', () => {
    const cwd = process.cwd()
    const selectedTestFile = path.join(tmpDir, 'packages/foo/test/scope.node.test.ts')
    const generatedTestFile = path.join(tmpDir, 'packages/foo/test/dd-trace-tm-quarantined.node.test.ts')

    fs.mkdirSync(path.dirname(selectedTestFile), { recursive: true })
    fs.writeFileSync(selectedTestFile, [
      'describe(\'scope\', () => {',
      '  test(\'works\', () => {',
      '    expect(true).toBe(true)',
      '  })',
      '})',
      '',
    ].join('\n'))

    process.chdir(tmpDir)
    fs.writeFileSync(
      'dd-test-optimization-test-command.txt',
      'yarn test packages/foo/test/scope.node.test.ts --runInBand\n'
    )
    fs.writeFileSync('dd-test-optimization-known-tests.json', JSON.stringify({
      jest: {
        'packages/foo/test/scope.node.test.ts': ['scope works'],
      },
    }))

    try {
      assert.deepStrictEqual(inferTestManagementPlan({
        auto: true,
        mode: 'quarantined',
      }), {
        auto: true,
        framework: 'jest',
        mode: 'quarantined',
        settingsMode: 'tm-quarantined',
        testCommand:
          'yarn test packages/foo/test/scope.node.test.ts ' +
          'packages/foo/test/dd-trace-tm-quarantined.node.test.ts --runInBand',
        testFile: 'packages/foo/test/dd-trace-tm-quarantined.node.test.ts',
      })

      writeAutoTestManagementPlan({ auto: true, mode: 'quarantined' })

      assert.strictEqual(
        fs.readFileSync('dd-test-optimization-tm-quarantined-command.txt', 'utf8'),
        'yarn test packages/foo/test/scope.node.test.ts ' +
          'packages/foo/test/dd-trace-tm-quarantined.node.test.ts --runInBand\n'
      )
      assert.strictEqual(fs.readFileSync('dd-test-optimization-tm-mode.txt', 'utf8'), 'quarantined\n')
      assert.strictEqual(fs.readFileSync('dd-test-optimization-tm-settings-mode.txt', 'utf8'), 'tm-quarantined\n')
      assert.strictEqual(fs.readFileSync('dd-test-optimization-tm-framework.txt', 'utf8'), 'jest\n')
      assert.strictEqual(
        fs.readFileSync('dd-test-optimization-tm-test-file.txt', 'utf8'),
        'packages/foo/test/dd-trace-tm-quarantined.node.test.ts\n'
      )
      assert.ok(!fs.existsSync(generatedTestFile))

      restoreTestManagementChecks()

      assert.ok(!fs.existsSync('dd-test-optimization-tm-quarantined-command.txt'))
      assert.ok(!fs.existsSync('dd-test-optimization-tm-mode.txt'))
      assert.ok(!fs.existsSync('dd-test-optimization-tm-settings-mode.txt'))
      assert.ok(!fs.existsSync('dd-test-optimization-tm-framework.txt'))
      assert.ok(!fs.existsSync('dd-test-optimization-tm-test-file.txt'))
      assert.ok(!fs.existsSync('dd-test-optimization-tm-test-command.txt'))
    } finally {
      process.chdir(cwd)
    }
  })

  it('infers Test Management helper state for nested package commands', () => {
    const cwd = process.cwd()
    const selectedTestFile = path.join(tmpDir, 'integrationTests/dev-jest/index.test.js')

    fs.mkdirSync(path.dirname(selectedTestFile), { recursive: true })
    fs.writeFileSync(selectedTestFile, getSimpleJestTestSource('works'))

    process.chdir(tmpDir)
    fs.writeFileSync(
      'dd-test-optimization-test-command.txt',
      'cd integrationTests/dev-jest && npm test -- index.test.js --runInBand\n'
    )
    fs.writeFileSync('dd-test-optimization-selected-test-files.txt', 'integrationTests/dev-jest/index.test.js\n')
    fs.writeFileSync('dd-test-optimization-known-tests.json', JSON.stringify({
      jest: {
        'index.test.js': ['works'],
      },
    }))

    try {
      assert.deepStrictEqual(inferTestManagementPlan({
        auto: true,
        mode: 'disabled',
      }), {
        auto: true,
        framework: 'jest',
        mode: 'disabled',
        settingsMode: 'tm-disabled',
        testCommand:
          'cd integrationTests/dev-jest && npm test -- index.test.js ' +
          'dd-trace-tm-disabled.test.js --runInBand',
        testFile: 'integrationTests/dev-jest/dd-trace-tm-disabled.test.js',
      })
    } finally {
      process.chdir(cwd)
    }
  })

  it('infers Test Management helper state from selected test files without known-tests', () => {
    const cwd = process.cwd()
    const selectedTestFile = path.join(tmpDir, 'packages/foo/test/scope.node.test.ts')

    fs.mkdirSync(path.dirname(selectedTestFile), { recursive: true })
    fs.writeFileSync(selectedTestFile, getSimpleJestTestSource('works'))

    process.chdir(tmpDir)
    fs.writeFileSync(
      'dd-test-optimization-test-command.txt',
      './node_modules/.bin/jest packages/foo/test/scope.node.test.ts --runInBand\n'
    )
    fs.writeFileSync('dd-test-optimization-selected-test-files.txt', 'packages/foo/test/scope.node.test.ts\n')

    try {
      assert.deepStrictEqual(inferTestManagementPlan({
        auto: true,
        mode: 'disabled',
      }), {
        auto: true,
        framework: 'jest',
        mode: 'disabled',
        settingsMode: 'tm-disabled',
        testCommand:
          './node_modules/.bin/jest packages/foo/test/scope.node.test.ts ' +
          'packages/foo/test/dd-trace-tm-disabled.node.test.ts --runInBand',
        testFile: 'packages/foo/test/dd-trace-tm-disabled.node.test.ts',
      })
    } finally {
      process.chdir(cwd)
    }
  })

  it('defaults generated Test Management Jest commands to run in band', () => {
    const cwd = process.cwd()
    const selectedTestFile = path.join(tmpDir, 'packages/foo/test/scope.node.test.ts')

    fs.mkdirSync(path.dirname(selectedTestFile), { recursive: true })
    fs.writeFileSync(selectedTestFile, getSimpleJestTestSource('works'))

    process.chdir(tmpDir)
    fs.writeFileSync(
      'dd-test-optimization-test-command.txt',
      './node_modules/.bin/jest packages/foo/test/scope.node.test.ts\n'
    )
    fs.writeFileSync('dd-test-optimization-selected-test-files.txt', 'packages/foo/test/scope.node.test.ts\n')

    try {
      assert.strictEqual(
        inferTestManagementPlan({
          auto: true,
          mode: 'disabled',
        }).testCommand,
        './node_modules/.bin/jest packages/foo/test/scope.node.test.ts ' +
          'packages/foo/test/dd-trace-tm-disabled.node.test.ts --runInBand'
      )
    } finally {
      process.chdir(cwd)
    }
  })

  it('defaults generated advanced Jest commands to run in band', () => {
    const cwd = process.cwd()
    const selectedTestFile = path.join(tmpDir, 'packages/foo/test/scope.node.test.ts')

    fs.mkdirSync(path.dirname(selectedTestFile), { recursive: true })
    fs.writeFileSync(selectedTestFile, getSimpleJestTestSource('works'))

    process.chdir(tmpDir)
    fs.writeFileSync(
      'dd-test-optimization-test-command.txt',
      './node_modules/.bin/jest packages/foo/test/scope.node.test.ts\n'
    )
    fs.writeFileSync('dd-test-optimization-selected-test-files.txt', 'packages/foo/test/scope.node.test.ts\n')

    try {
      assert.strictEqual(
        getAtrBaselinePlan({
          auto: true,
          baselineCandidate: true,
          framework: 'jest',
          frameworkExplicit: true,
        }).atrCommand,
        './node_modules/.bin/jest packages/foo/test/scope.node.test.ts ' +
          'packages/foo/test/dd-trace-atr-debug.node.test.ts --runInBand'
      )
    } finally {
      process.chdir(cwd)
    }
  })

  it('infers advanced generated candidates for nested package commands', () => {
    const cwd = process.cwd()
    const selectedTestFile = path.join(tmpDir, 'integrationTests/dev-jest/index.test.js')

    fs.mkdirSync(path.dirname(selectedTestFile), { recursive: true })
    fs.writeFileSync(selectedTestFile, getSimpleJestTestSource('works'))

    process.chdir(tmpDir)
    fs.writeFileSync(
      'dd-test-optimization-test-command.txt',
      'cd integrationTests/dev-jest && npm test -- index.test.js --runInBand\n'
    )
    fs.writeFileSync('dd-test-optimization-selected-test-files.txt', 'integrationTests/dev-jest/index.test.js\n')

    try {
      assert.deepStrictEqual(getAtrBaselinePlan({
        auto: true,
        baselineCandidate: true,
        framework: 'jest',
        frameworkExplicit: true,
      }), {
        atrCommand:
          'cd integrationTests/dev-jest && npm test -- index.test.js dd-trace-atr-debug.test.js --runInBand',
        atrTestFile: 'integrationTests/dev-jest/dd-trace-atr-debug.test.js',
        atrTestName: 'dd trace Auto Test Retries debug temporary test',
        framework: 'jest',
        source: getTemporaryTestSource(
          'jest',
          'dd trace Auto Test Retries debug temporary test',
          'dd trace Auto Test Retries debug'
        ),
      })

      fs.writeFileSync(
        'dd-test-optimization-atr-generated-test-file.txt',
        'integrationTests/dev-jest/dd-trace-atr-debug.test.js\n'
      )
      fs.writeFileSync(
        'dd-test-optimization-atr-baseline-command.txt',
        'cd integrationTests/dev-jest && npm test -- index.test.js dd-trace-atr-debug.test.js --runInBand\n'
      )
      fs.writeFileSync('dd-test-optimization-known-tests.json', JSON.stringify({
        jest: {
          'dd-trace-atr-debug.test.js': ['dd trace Auto Test Retries debug temporary test'],
        },
      }))

      assert.deepStrictEqual(inferPrepareOptions({ auto: true }), {
        auto: true,
        efdCommand:
          'cd integrationTests/dev-jest && npm test -- index.test.js dd-trace-atr-debug.test.js ' +
          'dd-trace-efd-debug.test.js --runInBand',
        efdTestFile: 'integrationTests/dev-jest/dd-trace-efd-debug.test.js',
        efdTestName: 'dd trace EFD debug temporary test',
        flakyTestFile: 'integrationTests/dev-jest/dd-trace-atr-debug.test.js',
        flakyTestName: 'dd trace Auto Test Retries debug temporary test',
        framework: 'jest',
      })
      assert.deepStrictEqual(inferTestManagementPlan({ auto: true, mode: 'disabled' }), {
        auto: true,
        framework: 'jest',
        mode: 'disabled',
        settingsMode: 'tm-disabled',
        testCommand:
          'cd integrationTests/dev-jest && npm test -- index.test.js --runInBand dd-trace-tm-disabled.test.js',
        testFile: 'integrationTests/dev-jest/dd-trace-tm-disabled.test.js',
      })
    } finally {
      process.chdir(cwd)
    }
  })

  it('uses package-relative generated paths for pnpm --dir commands', () => {
    assert.strictEqual(
      addTestFileToCommand(
        'pnpm --dir docs/src/prerender/bench exec vitest run src/basic.test.ts',
        'docs/src/prerender/bench/src/basic.test.ts',
        'docs/src/prerender/bench/src/dd-trace-atr-debug.test.ts'
      ),
      'pnpm --dir docs/src/prerender/bench exec vitest run ' +
        'src/basic.test.ts src/dd-trace-atr-debug.test.ts'
    )
  })

  it('preserves custom test file suffixes in generated advanced and Test Management files', () => {
    const cwd = process.cwd()
    const selectedTestFile = path.join(tmpDir, 'plugins/foo/src/helpers/error.unit.ts')

    fs.mkdirSync(path.dirname(selectedTestFile), { recursive: true })
    fs.writeFileSync(selectedTestFile, getSimpleJestTestSource('works'))

    process.chdir(tmpDir)
    fs.writeFileSync(
      'dd-test-optimization-test-command.txt',
      'yarn test:unit plugins/foo/src/helpers/error.unit.ts --runInBand\n'
    )
    fs.writeFileSync('dd-test-optimization-selected-test-files.txt', 'plugins/foo/src/helpers/error.unit.ts\n')
    fs.writeFileSync('dd-test-optimization-known-tests.json', JSON.stringify({
      jest: {
        'plugins/foo/src/helpers/error.unit.ts': ['error works'],
      },
    }))

    try {
      assert.strictEqual(
        getTemporaryEfdTestFile('plugins/foo/src/helpers/error.unit.ts'),
        'plugins/foo/src/helpers/dd-trace-efd-debug.unit.ts'
      )
      assert.deepStrictEqual(inferPrepareOptions({ auto: true }), {
        auto: true,
        efdCommand:
          'yarn test:unit plugins/foo/src/helpers/error.unit.ts ' +
          'plugins/foo/src/helpers/dd-trace-efd-debug.unit.ts --runInBand',
        efdTestFile: 'plugins/foo/src/helpers/dd-trace-efd-debug.unit.ts',
        efdTestName: 'dd trace EFD debug temporary test',
        flakyTestFile: 'plugins/foo/src/helpers/error.unit.ts',
        flakyTestName: 'error works',
        framework: 'jest',
      })
      assert.strictEqual(
        inferTestManagementPlan({ auto: true, mode: 'attempt-to-fix' }).testFile,
        'plugins/foo/src/helpers/dd-trace-tm-attempt-to-fix.unit.ts'
      )
    } finally {
      process.chdir(cwd)
    }
  })

  it('prepares source-safe generated Auto Test Retries candidates for advanced checks', () => {
    const cwd = process.cwd()
    const selectedTestFile = path.join(tmpDir, 'test/sum.spec.js')
    const generatedAtrFile = path.join(tmpDir, 'test/dd-trace-atr-debug.spec.js')
    const generatedEfdFile = path.join(tmpDir, 'test/dd-trace-efd-debug.spec.js')

    fs.mkdirSync(path.dirname(selectedTestFile), { recursive: true })
    fs.writeFileSync(selectedTestFile, [
      'const assert = require(\'node:assert/strict\')',
      '',
      'describe(\'sum\', () => {',
      '  it(\'adds numbers\', () => {',
      '    assert.strictEqual(1 + 1, 2)',
      '  })',
      '})',
      '',
    ].join('\n'))

    process.chdir(tmpDir)
    fs.writeFileSync('dd-test-optimization-test-command.txt', 'npm test -- test/sum.spec.js\n')
    fs.writeFileSync('dd-test-optimization-selected-test-files.txt', 'test/sum.spec.js\n')
    fs.writeFileSync('dd-test-optimization-static.json', JSON.stringify(getStaticReport()))

    try {
      assert.deepStrictEqual(getAtrBaselinePlan({ auto: true, baselineCandidate: true }), {
        atrCommand: 'npm test -- test/sum.spec.js test/dd-trace-atr-debug.spec.js',
        atrTestFile: 'test/dd-trace-atr-debug.spec.js',
        atrTestName: 'dd trace Auto Test Retries debug temporary test',
        framework: 'mocha',
        source: [
          '\'use strict\'',
          '',
          'const assert = require(\'node:assert/strict\')',
          '',
          'describe("dd trace Auto Test Retries debug", () => {',
          '  it("dd trace Auto Test Retries debug temporary test", () => {',
          '    assert.strictEqual(1 + 1, 2)',
          '  })',
          '})',
          '',
        ].join('\n'),
      })

      prepareAtrBaselineCandidate({ auto: true, baselineCandidate: true })

      assert.ok(fs.existsSync(generatedAtrFile))
      assert.match(fs.readFileSync(generatedAtrFile, 'utf8'), /dd trace Auto Test Retries debug/)
      assert.strictEqual(
        fs.readFileSync('dd-test-optimization-atr-baseline-command.txt', 'utf8'),
        'npm test -- test/sum.spec.js test/dd-trace-atr-debug.spec.js\n'
      )

      fs.writeFileSync('dd-test-optimization-known-tests.json', JSON.stringify({
        mocha: {
          'test/sum.spec.js': ['sum adds numbers'],
          'test/dd-trace-atr-debug.spec.js': [
            'dd trace Auto Test Retries debug dd trace Auto Test Retries debug temporary test',
          ],
        },
      }))

      assert.deepStrictEqual(inferPrepareOptions({ auto: true }), {
        auto: true,
        efdCommand:
          'npm test -- test/sum.spec.js test/dd-trace-atr-debug.spec.js test/dd-trace-efd-debug.spec.js',
        efdTestFile: 'test/dd-trace-efd-debug.spec.js',
        efdTestName: 'dd trace EFD debug temporary test',
        flakyTestFile: 'test/dd-trace-atr-debug.spec.js',
        flakyTestName: 'dd trace Auto Test Retries debug dd trace Auto Test Retries debug temporary test',
        framework: 'mocha',
      })

      prepareAdvancedChecks({ auto: true })

      assert.ok(fs.existsSync(generatedEfdFile))
      assert.match(fs.readFileSync(generatedAtrFile, 'utf8'), /dd trace auto retry debug flake/)
      assert.ok(!fs.existsSync('dd-test-optimization-atr-flaky-test-backup.txt'))

      restoreAdvancedChecks()

      const cleanup = JSON.parse(fs.readFileSync('dd-test-optimization-advanced-cleanup.json', 'utf8'))
      assert.strictEqual(cleanup.ok, true)
      assert.deepStrictEqual(cleanup.stateFilesRemaining, [])
      assert.ok(cleanup.paths.some(entry =>
        entry.path === 'test/dd-trace-atr-debug.spec.js' && entry.remaining === false
      ))
      assert.ok(cleanup.paths.some(entry =>
        entry.path === 'test/dd-trace-efd-debug.spec.js' && entry.remaining === false
      ))
      assert.ok(!fs.existsSync(generatedAtrFile))
      assert.ok(!fs.existsSync(generatedEfdFile))
      assert.strictEqual(fs.readFileSync(selectedTestFile, 'utf8').includes('dd trace auto retry debug flake'), false)
    } finally {
      process.chdir(cwd)
    }
  })

  it('refuses to prepare advanced checks when the known test file has git changes', () => {
    const cwd = process.cwd()
    const testFile = path.join(tmpDir, 'test/sum.spec.js')
    const efdTestFile = path.join(tmpDir, 'test/dd-trace-efd-debug.spec.js')
    const original = [
      'const assert = require(\'node:assert/strict\')',
      '',
      'describe(\'sum\', () => {',
      '  it(\'adds numbers\', () => {',
      '    assert.strictEqual(1 + 1, 2)',
      '  })',
      '})',
      '',
    ].join('\n')

    fs.mkdirSync(path.dirname(testFile), { recursive: true })
    fs.writeFileSync(testFile, original)
    process.chdir(tmpDir)

    try {
      execFileSync('git', ['init'], { stdio: 'ignore' })
      execFileSync('git', ['add', 'test/sum.spec.js'], { stdio: 'ignore' })
      execFileSync('git', [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        'init',
      ], { stdio: 'ignore' })

      fs.appendFileSync(testFile, '// local edit\n')

      assert.throws(() => prepareAdvancedChecks({
        efdCommand: 'npm test -- test/sum.spec.js test/dd-trace-efd-debug.spec.js',
        efdTestFile: 'test/dd-trace-efd-debug.spec.js',
        flakyTestFile: 'test/sum.spec.js',
        flakyTestName: 'adds numbers',
        framework: 'mocha',
      }), /Refusing to edit dirty known test file/)
      assert.ok(!fs.existsSync(efdTestFile))
      assert.ok(!fs.existsSync('dd-test-optimization-atr-flaky-test-file.txt'))
    } finally {
      process.chdir(cwd)
    }
  })

  it('infers advanced check options from known-tests and selected-command artifacts', () => {
    const cwd = process.cwd()
    const testFile = path.join(tmpDir, 'test/sum.spec.js')
    const efdTestFile = path.join(tmpDir, 'test/dd-trace-efd-debug.spec.js')
    const original = [
      'const assert = require(\'node:assert/strict\')',
      '',
      'describe(\'sum\', () => {',
      '  it(\'adds numbers\', () => {',
      '    assert.strictEqual(1 + 1, 2)',
      '  })',
      '})',
      '',
    ].join('\n')

    fs.mkdirSync(path.dirname(testFile), { recursive: true })
    fs.writeFileSync(testFile, original)
    process.chdir(tmpDir)
    fs.writeFileSync('dd-test-optimization-test-command.txt', 'npm test -- test/sum.spec.js\n')
    fs.writeFileSync('dd-test-optimization-known-tests.json', JSON.stringify({
      mocha: {
        'test/sum.spec.js': ['sum adds numbers'],
      },
    }))

    try {
      assert.deepStrictEqual(inferPrepareOptions({ auto: true }), {
        auto: true,
        efdCommand: 'npm test -- test/sum.spec.js test/dd-trace-efd-debug.spec.js',
        efdTestFile: 'test/dd-trace-efd-debug.spec.js',
        efdTestName: 'dd trace EFD debug temporary test',
        flakyTestFile: 'test/sum.spec.js',
        flakyTestName: 'sum adds numbers',
        framework: 'mocha',
      })

      prepareAdvancedChecks({ auto: true })

      assert.ok(fs.existsSync(efdTestFile))
      assert.match(fs.readFileSync(efdTestFile, 'utf8'), /assert\.strictEqual/)
      assert.match(fs.readFileSync(testFile, 'utf8'), /dd trace auto retry debug flake/)
      assert.strictEqual(
        fs.readFileSync('dd-test-optimization-efd-command.txt', 'utf8'),
        'npm test -- test/sum.spec.js test/dd-trace-efd-debug.spec.js\n'
      )
      assert.strictEqual(
        fs.readFileSync('dd-test-optimization-atr-flaky-test-name.txt', 'utf8'),
        'sum adds numbers\n'
      )

      restoreAdvancedChecks()

      const cleanup = JSON.parse(fs.readFileSync('dd-test-optimization-advanced-cleanup.json', 'utf8'))
      assert.strictEqual(cleanup.ok, true)
      assert.deepStrictEqual(cleanup.stateFilesRemaining, [])
      assert.ok(!fs.existsSync(efdTestFile))
      assert.strictEqual(fs.readFileSync(testFile, 'utf8'), original)
    } finally {
      process.chdir(cwd)
    }
  })

  it('inserts inferred EFD test files before trailing runner flags', () => {
    const cwd = process.cwd()
    const testFile = path.join(tmpDir, 'packages/plugin-gate/src/__tests__/scope.test.ts')

    fs.mkdirSync(path.dirname(testFile), { recursive: true })
    fs.writeFileSync(testFile, [
      'describe(\'scope\', () => {',
      '  test(\'parses scope\', () => {',
      '    expect(true).toBe(true)',
      '  })',
      '})',
      '',
    ].join('\n'))
    process.chdir(tmpDir)
    fs.writeFileSync(
      'dd-test-optimization-test-command.txt',
      'yarn test packages/plugin-gate/src/__tests__/scope.test.ts --runInBand\n'
    )
    fs.writeFileSync('dd-test-optimization-known-tests.json', JSON.stringify({
      jest: {
        'packages/plugin-gate/src/__tests__/scope.test.ts': ['scope parses scope'],
      },
    }))

    try {
      assert.deepStrictEqual(inferPrepareOptions({ auto: true }), {
        auto: true,
        efdCommand:
          'yarn test packages/plugin-gate/src/__tests__/scope.test.ts ' +
          'packages/plugin-gate/src/__tests__/dd-trace-efd-debug.test.ts --runInBand',
        efdTestFile: 'packages/plugin-gate/src/__tests__/dd-trace-efd-debug.test.ts',
        efdTestName: 'dd trace EFD debug temporary test',
        flakyTestFile: 'packages/plugin-gate/src/__tests__/scope.test.ts',
        flakyTestName: 'scope parses scope',
        framework: 'jest',
      })
    } finally {
      process.chdir(cwd)
    }
  })

  it('preserves selected test file qualifiers for inferred EFD test files', () => {
    const cwd = process.cwd()
    const testFile = path.join(tmpDir, 'packages/example-service/test/utils.node.test.ts')

    fs.mkdirSync(path.dirname(testFile), { recursive: true })
    fs.writeFileSync(testFile, [
      'describe(\'utils\', () => {',
      '  test(\'works\', () => {',
      '    expect(true).toBe(true)',
      '  })',
      '})',
      '',
    ].join('\n'))
    process.chdir(tmpDir)
    fs.writeFileSync(
      'dd-test-optimization-test-command.txt',
      'yarn test packages/example-service/test/utils.node.test.ts --runInBand\n'
    )
    fs.writeFileSync('dd-test-optimization-known-tests.json', JSON.stringify({
      jest: {
        'packages/example-service/test/utils.node.test.ts': ['utils works'],
      },
    }))

    try {
      assert.deepStrictEqual(inferPrepareOptions({ auto: true }), {
        auto: true,
        efdCommand:
          'yarn test packages/example-service/test/utils.node.test.ts ' +
          'packages/example-service/test/dd-trace-efd-debug.node.test.ts --runInBand',
        efdTestFile: 'packages/example-service/test/dd-trace-efd-debug.node.test.ts',
        efdTestName: 'dd trace EFD debug temporary test',
        flakyTestFile: 'packages/example-service/test/utils.node.test.ts',
        flakyTestName: 'utils works',
        framework: 'jest',
      })
    } finally {
      process.chdir(cwd)
    }
  })

  it('builds selected test commands for common package managers', () => {
    assert.strictEqual(
      addRunInBandToCommand('yarn test packages/foo/src/__tests__/scope.test.ts'),
      'yarn test packages/foo/src/__tests__/scope.test.ts --runInBand'
    )
    assert.strictEqual(
      addRunInBandToCommand('yarn test packages/foo/src/__tests__/scope.test.ts --runInBand'),
      'yarn test packages/foo/src/__tests__/scope.test.ts --runInBand'
    )
    assert.strictEqual(
      buildTestCommand({
        scripts: {
          test: 'node node_modules/jest/bin/jest',
        },
      }, 'yarn', 'jest', 'packages/foo/src/__tests__/scope.test.ts'),
      'yarn test packages/foo/src/__tests__/scope.test.ts --runInBand'
    )
    assert.strictEqual(
      buildTestCommand({
        scripts: {
          test: 'mocha',
        },
      }, 'npm', 'mocha', 'test/sum.spec.js'),
      'npm test -- test/sum.spec.js'
    )
    assert.strictEqual(
      buildTestCommand({}, 'npm', 'vitest', 'test/sum.test.ts'),
      './node_modules/.bin/vitest run test/sum.test.ts'
    )
    assert.strictEqual(
      buildTestCommand({
        scripts: {
          test: 'node --test',
        },
      }, 'npm', 'vitest', 'test/sum.test.ts'),
      './node_modules/.bin/vitest run test/sum.test.ts'
    )
    assert.strictEqual(
      buildTestCommand({
        scripts: {
          test: 'mocha --require test/support/env --reporter spec --check-leaks test/ test/acceptance/',
        },
      }, 'npm', 'mocha', 'test/utils.js'),
      './node_modules/.bin/mocha --require test/support/env --reporter spec --check-leaks test/utils.js'
    )
    assert.strictEqual(
      buildTestCommand({
        scripts: {
          ci: 'vitest run',
          test: 'pnpm lint && vitest run',
        },
      }, 'pnpm', 'vitest', 'scripts/e2e-diagram-scope.spec.ts'),
      'pnpm run ci scripts/e2e-diagram-scope.spec.ts'
    )
    assert.strictEqual(
      buildTestCommand({
        scripts: {
          bench: 'vitest bench --run',
        },
      }, 'pnpm', 'vitest', 'route-pattern.bench.test.ts'),
      './node_modules/.bin/vitest run route-pattern.bench.test.ts'
    )
    assert.strictEqual(
      buildTestCommand({
        scripts: {
          test: 'jest',
        },
      }, 'npm', 'jest', 'index.test.js', 'integrationTests/dev-jest'),
      'cd integrationTests/dev-jest && npm test -- index.test.js --runInBand'
    )
  })

  it('rejects unsupported-only framework selection before live validation', () => {
    assert.throws(() => detectFramework({
      scripts: {
        test: 'node --test src/*.test.js',
      },
    }), /Only unsupported test framework\(s\) were detected: Node\.js test runner/)
    assert.throws(() => detectFramework({
      devDependencies: {
        tap: '^18.0.0',
      },
      scripts: {
        test: 'tap test/*.js',
      },
    }, {
      framework: 'tap',
    }), /tap is not supported by this selector/)
  })

  it('writes a static-only full validation payload when only unsupported frameworks are detected', (done) => {
    const cwd = process.cwd()

    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      scripts: {
        test: 'node --test test/*.js',
      },
    }))

    process.chdir(tmpDir)

    runFullValidation({ open: false }, (error, report) => {
      try {
        assert.ifError(error)

        const diagnosis = JSON.parse(fs.readFileSync('dd-test-optimization-diagnosis.json', 'utf8'))
        const validationPayload = getValidationPayload(report)
        const basicCheck = validationPayload.checks.find(check => check.id === 'basic-reporting')

        assert.match(
          diagnosis.likelyFailureCause,
          /Only unsupported test framework\(s\) were detected: Node\.js test runner/
        )
        assert.match(report, /Summary:\n- Reporting: failed \(Not run\)/)
        assert.doesNotMatch(report, /Advanced skip reason:/)
        assert.strictEqual(validationPayload.status, 'failed')
        assert.strictEqual(basicCheck.status, 'failed')
        assert.match(basicCheck.reason, /Node\.js test runner/)
        assert.ok(fs.existsSync('dd-test-optimization-validation-url.txt'))
      } catch (assertionError) {
        done(assertionError)
        return
      } finally {
        process.chdir(cwd)
      }

      done()
    })
  })

  it('selects a clean unit test command and writes F0-select inputs', () => {
    const cwd = process.cwd()
    const e2eTestFile = path.join(tmpDir, 'e2e/cloud-run.test.ts')
    const dirtyTestFile = path.join(tmpDir, 'packages/dirty/src/__tests__/scope.test.ts')
    const selectedTestFile = path.join(tmpDir, 'packages/plugin-gate/src/__tests__/scope.test.ts')

    fs.mkdirSync(path.dirname(e2eTestFile), { recursive: true })
    fs.mkdirSync(path.dirname(dirtyTestFile), { recursive: true })
    fs.mkdirSync(path.dirname(selectedTestFile), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      devDependencies: {
        jest: '29.6.4',
      },
      packageManager: 'yarn@4.10.3',
      scripts: {
        test: 'node node_modules/jest/bin/jest --colors',
      },
    }))
    fs.writeFileSync(e2eTestFile, getSimpleJestTestSource('cloud run works'))
    fs.writeFileSync(dirtyTestFile, getSimpleJestTestSource('dirty test works'))
    fs.writeFileSync(selectedTestFile, getSimpleJestTestSource('scope test works'))

    process.chdir(tmpDir)

    try {
      execFileSync('git', ['init'], { stdio: 'ignore' })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { stdio: 'ignore' })
      execFileSync('git', ['config', 'user.name', 'Test'], { stdio: 'ignore' })
      execFileSync('git', ['add', '.'], { stdio: 'ignore' })
      execFileSync('git', [
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        'init',
      ], { stdio: 'ignore' })

      fs.appendFileSync(dirtyTestFile, '// local edit\n')

      const selection = selectTestCommand()

      assert.deepStrictEqual({
        command: selection.command,
        file: selection.file,
        framework: selection.framework,
        packageManager: selection.packageManager,
      }, {
        command: 'yarn test packages/plugin-gate/src/__tests__/scope.test.ts --runInBand',
        file: 'packages/plugin-gate/src/__tests__/scope.test.ts',
        framework: 'jest',
        packageManager: 'yarn',
      })

      writeSelection({
        commandOut: 'dd-test-optimization-selected-command.input',
        filesOut: 'dd-test-optimization-selected-files.input',
      }, selection)

      assert.strictEqual(
        fs.readFileSync('dd-test-optimization-selected-command.input', 'utf8'),
        'yarn test packages/plugin-gate/src/__tests__/scope.test.ts --runInBand\n'
      )
      assert.strictEqual(
        fs.readFileSync('dd-test-optimization-selected-files.input', 'utf8'),
        'packages/plugin-gate/src/__tests__/scope.test.ts\n'
      )
    } finally {
      process.chdir(cwd)
    }
  })

  it('selects plain files under test for mocha repositories', () => {
    const cwd = process.cwd()
    const selectedTestFile = path.join(tmpDir, 'test/app.listen.js')

    fs.mkdirSync(path.dirname(selectedTestFile), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      devDependencies: {
        mocha: '11.7.6',
      },
      scripts: {
        test: 'mocha',
      },
    }))
    fs.writeFileSync(selectedTestFile, [
      'describe("app.listen", () => {',
      '  it("works", () => {})',
      '})',
      '',
    ].join('\n'))

    process.chdir(tmpDir)

    try {
      const selection = selectTestCommand()

      assert.deepStrictEqual({
        command: selection.command,
        file: selection.file,
        framework: selection.framework,
        packageManager: selection.packageManager,
      }, {
        command: 'npm test -- test/app.listen.js',
        file: 'test/app.listen.js',
        framework: 'mocha',
        packageManager: 'npm',
      })
    } finally {
      process.chdir(cwd)
    }
  })

  it('dry-runs advanced check preparation without writing temporary edits', () => {
    const cwd = process.cwd()
    const testFile = path.join(tmpDir, 'test/sum.spec.js')
    const efdTestFile = path.join(tmpDir, 'test/dd-trace-efd-debug.spec.js')
    const prepareScript = path.join(cwd, 'ci/test-optimization-prepare-advanced.js')
    const original = [
      'const assert = require(\'node:assert/strict\')',
      '',
      'describe(\'sum\', () => {',
      '  it(\'adds numbers\', () => {',
      '    assert.strictEqual(1 + 1, 2)',
      '  })',
      '})',
      '',
    ].join('\n')

    fs.mkdirSync(path.dirname(testFile), { recursive: true })
    fs.writeFileSync(testFile, original)
    process.chdir(tmpDir)
    fs.writeFileSync('dd-test-optimization-test-command.txt', 'npm test -- test/sum.spec.js\n')
    fs.writeFileSync('dd-test-optimization-known-tests.json', JSON.stringify({
      mocha: {
        'test/sum.spec.js': ['sum adds numbers'],
      },
    }))

    try {
      const output = execFileSync(process.execPath, [prepareScript, '--auto', '--dry-run'], {
        encoding: 'utf8',
      })

      assert.ok(!fs.existsSync(efdTestFile))
      assert.strictEqual(fs.readFileSync(testFile, 'utf8'), original)
      assert.ok(!fs.existsSync('dd-test-optimization-efd-command.txt'))
      assert.match(output, /Advanced helper dry run:/)
      assert.match(output, /Temporary EFD test file: test\/dd-trace-efd-debug\.spec\.js/)
      assert.match(output, /Auto Test Retries flaky test file: test\/sum\.spec\.js/)
      assert.match(output, /No files written\./)
    } finally {
      process.chdir(cwd)
    }
  })

  it('inserts one-time flaky failure into simple test callbacks', () => {
    const source = [
      'import {parseScope} from \'../utils\'',
      '',
      'describe(\'parseScope\', () => {',
      '  test(\'falls back\', () => {',
      '    expect(parseScope([\'\'])).toEqual({})',
      '  })',
      '})',
      '',
    ].join('\n')
    const result = insertFlakyFailure(source, 'falls back')

    assert.match(result.source, /let ddTraceAutoRetryCounter = 0/)
    assert.match(result.source, /throw new Error\('dd trace auto retry debug flake'\)/)
    assert.match(result.snippet, /test\('falls back'/)
  })

  it('inserts one-time flaky failure after multi-line imports', () => {
    const source = [
      'import {',
      '  parseScope,',
      '} from \'../utils\'',
      '',
      'describe(\'parseScope\', () => {',
      '  test(\'falls back\', () => {',
      '    expect(parseScope([\'\'])).toEqual({})',
      '  })',
      '})',
      '',
    ].join('\n')
    const result = insertFlakyFailure(source, 'falls back')

    assert.match(result.source, /} from '\.\.\/utils'\nlet ddTraceAutoRetryCounter = 0/)
    assert.doesNotMatch(result.source, /import \{\nlet ddTraceAutoRetryCounter = 0/)
    assert.match(result.source, /throw new Error\('dd trace auto retry debug flake'\)/)
  })

  it('matches suite-qualified names when preparing flaky known tests', () => {
    const source = [
      'import {parseScope} from \'../utils\'',
      '',
      'describe(\'parseScope\', () => {',
      '  test(\'falls back\', () => {',
      '    expect(parseScope([\'\'])).toEqual({})',
      '  })',
      '})',
      '',
    ].join('\n')
    const result = insertFlakyFailure(source, 'parseScope falls back')

    assert.match(result.source, /let ddTraceAutoRetryCounter = 0/)
    assert.match(result.source, /throw new Error\('dd trace auto retry debug flake'\)/)
    assert.match(result.snippet, /test\('falls back'/)
  })

  it('renders the final runbook report', () => {
    const staticPath = path.join(tmpDir, 'static.json')
    const intakePath = path.join(tmpDir, 'intake.json')
    const htmlPath = path.join(tmpDir, 'report.html')
    const testCommandPath = path.join(tmpDir, 'test-command.txt')
    const testExitCodePath = path.join(tmpDir, 'test-exit-code.txt')
    const envPath = path.join(tmpDir, 'env.txt')
    const testCommand = 'npm test -- test/sum.spec.js'

    fs.writeFileSync(staticPath, JSON.stringify(getStaticReport(), null, 2))
    fs.writeFileSync(intakePath, JSON.stringify(getCompleteIntakeArtifact(intakePath, htmlPath), null, 2))
    fs.writeFileSync(testCommandPath, `${testCommand}\n`)
    fs.writeFileSync(testExitCodePath, '0\n')
    fs.writeFileSync(envPath, [
      'DD_API_KEY=debug',
      'DD_SERVICE=dd-test-optimization-debug',
      'DD_CIVISIBILITY_AGENTLESS_ENABLED=1',
      'DD_CIVISIBILITY_AGENTLESS_URL=http://127.0.0.1:12345',
      'DD_INSTRUMENTATION_TELEMETRY_ENABLED=false',
      'NODE_OPTIONS=-r dd-trace/ci/init',
      '',
    ].join('\n'))

    const report = renderFinalReport({
      static: staticPath,
      intake: intakePath,
      testCommandFile: testCommandPath,
      testExitCodeFile: testExitCodePath,
      testResult: '3 passing',
      envFile: envPath,
      agentReport: path.join(tmpDir, 'agent.txt'),
      agentJsonReport: path.join(tmpDir, 'agent.json'),
    })

    assert.match(report, new RegExp(`^HTML report: ${escapeRegExp(pathToFileURL(htmlPath).href)}\\n`))
    assert.match(report, /\nDatadog validation: ci\/test\/validation#pako:/)
    assert.match(report, /Primary funnel stage: Reporting complete/)
    assert.match(report, /Scope:\n- Selected test subset only\./)
    assert.match(report, /Summary:\n- Reporting: OK/)
    assert.match(report, /Test command used:\nnpm test -- test\/sum\.spec\.js/)
    assert.match(report, /Expected for this live run; Step 4 injected NODE_OPTIONS="-r dd-trace\/ci\/init"/)
    assert.match(report, /What this proves:/)
    assert.doesNotMatch(report, /HTML report path:/)
    assert.doesNotMatch(report, /- Framework:/)
    assert.doesNotMatch(report, /Consistency checks:/)
    assert.doesNotMatch(report, /DD_API_KEY=debug/)
    assert.doesNotMatch(report, /warning: DD_SERVICE/)
    assert.doesNotMatch(report, /What this does not prove:/)
    assert.doesNotMatch(report, /Diagnostic answers:/)
    assert.doesNotMatch(report, /Artifacts:/)

    const validationPayload = getValidationPayload(report)
    const summary = renderSummaryReport({
      static: staticPath,
      intake: intakePath,
      testCommandFile: testCommandPath,
      testExitCodeFile: testExitCodePath,
      testResult: '3 passing',
      envFile: envPath,
      agentReport: path.join(tmpDir, 'agent.txt'),
      agentJsonReport: path.join(tmpDir, 'agent.json'),
    })
    const basicCheck = validationPayload.checks.find(check => check.id === 'basic-reporting')
    const runTestsStep = basicCheck.steps.find(step => step.id === 'run-tests')
    const eventsStep = basicCheck.steps.find(step => step.id === 'check-events')

    assert.strictEqual(validationPayload.status, 'ok')
    assert.deepStrictEqual(validationPayload.framework, {
      id: 'mocha',
      name: 'Mocha',
      version: '11.7.6',
    })
    assert.strictEqual(runTestsStep.command, testCommand)
    assert.strictEqual(runTestsStep.exitCode, '0')
    assert.strictEqual(runTestsStep.result, '3 passing')
    assert.strictEqual(eventsStep.evidence.events.sessions, 1)
    assert.strictEqual(eventsStep.evidence.events.modules, 1)
    assert.strictEqual(eventsStep.evidence.events.suites, 1)
    assert.strictEqual(eventsStep.evidence.events.tests, 1)
    assert.deepStrictEqual(eventsStep.evidence.samples, [
      { level: 'test session', 'test.command': 'npm test -- test/sum.spec.js' },
      { level: 'test module', 'test.command': 'npm test -- test/sum.spec.js' },
      { level: 'test suite', 'test.suite': 'test/sum.spec.js' },
      { level: 'test', 'test.name': 'sum adds positive numbers' },
    ])
    assert.strictEqual(validationPayload.artifacts.htmlFileUrl, pathToFileURL(htmlPath).href)
    assert.strictEqual(validationPayload.summary, undefined)
    assert.strictEqual(validationPayload.env, undefined)
    assert.strictEqual(validationPayload.test, undefined)
    assert.strictEqual(basicCheck.reason, undefined)
    assert.match(summary, /Test Optimization debug summary/)
    assert.match(summary, /Primary funnel stage: Reporting complete/)
    assert.match(summary, /Summary:\n- Reporting: OK/)
    assert.match(summary, /Test command used:\nnpm test -- test\/sum\.spec\.js/)
    assert.doesNotMatch(summary, /HTML report path:/)
    assert.doesNotMatch(summary, /Consistency checks:/)
    assert.doesNotMatch(summary, /Static warnings\/errors:/)
  })

  it('includes likely failure cause in failed validation payloads', () => {
    const staticPath = path.join(tmpDir, 'static.json')
    const intakePath = path.join(tmpDir, 'intake.json')
    const htmlPath = path.join(tmpDir, 'report.html')
    const staticReport = getUnsupportedJestStaticReport()

    staticReport.results.push({ ...staticReport.results[0] })
    fs.writeFileSync(staticPath, JSON.stringify(staticReport, null, 2))
    fs.writeFileSync(intakePath, JSON.stringify(getSessionOnlyIntakeArtifact(intakePath, htmlPath), null, 2))

    const report = renderFinalReport({
      static: staticPath,
      intake: intakePath,
      testCommand: 'yarn test:unit packages/foo/scope.test.js',
      testExitCode: '0',
      testResult: '1 passed',
      agentReport: path.join(tmpDir, 'agent.txt'),
      agentJsonReport: path.join(tmpDir, 'agent.json'),
    })
    const validationPayload = getValidationPayload(report)
    const basicCheck = validationPayload.checks.find(check => check.id === 'basic-reporting')
    const eventsStep = basicCheck.steps.find(step => step.id === 'check-events')

    const likelyCause = report.split(/\r?\n/).find(line => line.startsWith('- error: Likely failure cause -'))

    assert.match(likelyCause, /Static diagnosis found unsupported framework version\(s\): Jest 27\.5\.1 is not supported/)
    assert.strictEqual((likelyCause.match(/Jest 27\.5\.1 is not supported/g) || []).length, 1)
    assert.match(basicCheck.reason, /Jest 27\.5\.1 is not supported/)
    assert.match(eventsStep.evidence.reason, /Jest 27\.5\.1 is not supported/)
  })

  it('does not attribute a live supported command failure to unrelated unsupported frameworks', () => {
    const staticPath = path.join(tmpDir, 'static.json')
    const intakePath = path.join(tmpDir, 'intake.json')
    const htmlPath = path.join(tmpDir, 'report.html')
    const staticReport = {
      ddTraceVersion: '6.0.0-pre',
      supportedFrameworks: [
        {
          id: 'jest',
          name: 'Jest',
          versionDetections: [
            {
              version: '30.2.0',
            },
          ],
        },
      ],
      unsupportedFrameworks: [
        {
          id: 'node-test',
          name: 'Node.js test runner',
        },
      ],
      results: [],
    }

    fs.writeFileSync(staticPath, JSON.stringify(staticReport, null, 2))
    fs.writeFileSync(intakePath, JSON.stringify(getSessionOnlyIntakeArtifact(intakePath, htmlPath), null, 2))

    const report = renderFinalReport({
      static: staticPath,
      intake: intakePath,
      testCommand: 'npm test -- src/masking/__tests__/utils.test.ts --runInBand',
      testExitCode: '0',
      testResult: 'unknown',
      agentReport: path.join(tmpDir, 'agent.txt'),
      agentJsonReport: path.join(tmpDir, 'agent.json'),
    })
    const validationPayload = getValidationPayload(report)
    const basicCheck = validationPayload.checks.find(check => check.id === 'basic-reporting')

    assert.doesNotMatch(basicCheck.reason, /Node\.js test runner/)
    assert.match(basicCheck.reason, /per-test hooks did not fire/)
  })

  it('attributes failed Jest collection to TypeScript config loader risk when present', () => {
    const staticPath = path.join(tmpDir, 'static.json')
    const intakePath = path.join(tmpDir, 'intake.json')
    const htmlPath = path.join(tmpDir, 'report.html')
    const staticReport = {
      ddTraceVersion: '6.0.0-pre',
      supportedFrameworks: [
        {
          id: 'jest',
          name: 'Jest',
          versionDetections: [
            {
              version: '30.2.0',
            },
          ],
        },
      ],
      results: [
        {
          status: 'warning',
          title: 'Jest TypeScript config may need ts-node',
          message: 'A jest.config.ts file was found, but ts-node was not detected.',
          recommendation: 'Install ts-node for the diagnostic run, or use a temporary JSON/CommonJS Jest config.',
        },
      ],
    }

    fs.writeFileSync(staticPath, JSON.stringify(staticReport, null, 2))
    fs.writeFileSync(intakePath, JSON.stringify(getSessionOnlyIntakeArtifact(intakePath, htmlPath), null, 2))

    const report = renderFinalReport({
      static: staticPath,
      intake: intakePath,
      testCommand: 'npm test -- src/masking/__tests__/utils.test.ts --runInBand',
      testExitCode: '0',
      testResult: 'unknown',
      agentReport: path.join(tmpDir, 'agent.txt'),
      agentJsonReport: path.join(tmpDir, 'agent.json'),
    })
    const validationPayload = getValidationPayload(report)
    const basicCheck = validationPayload.checks.find(check => check.id === 'basic-reporting')

    assert.match(basicCheck.reason, /Jest TypeScript config may need ts-node/)
    assert.match(basicCheck.reason, /temporary JSON\/CommonJS Jest config/)
  })

  it('builds a static-only validation payload with a skip reason', () => {
    const payload = buildStaticValidationPayload({
      diagnosis: {
        likelyFailureCause: 'Static diagnosis found unsupported framework versions.',
      },
      framework: 'jest',
      staticReport: getUnsupportedJestStaticReport(),
      testCommand: 'not run',
      testResult: 'skipped',
    })
    const basicCheck = payload.checks.find(check => check.id === 'basic-reporting')
    const runStep = basicCheck.steps.find(step => step.id === 'run-tests')
    const eventsStep = basicCheck.steps.find(step => step.id === 'check-events')

    assert.strictEqual(payload.status, 'failed')
    assert.deepStrictEqual(payload.framework, {
      id: 'jest',
      name: 'Jest',
      version: '27.5.1',
    })
    assert.strictEqual(basicCheck.status, 'failed')
    assert.strictEqual(basicCheck.reason, 'Static diagnosis found unsupported framework versions.')
    assert.strictEqual(runStep.status, 'skipped')
    assert.strictEqual(runStep.command, 'not run')
    assert.strictEqual(eventsStep.evidence.requestCount, 0)
    assert.strictEqual(eventsStep.evidence.reason, 'Static diagnosis found unsupported framework versions.')
  })

  it('renders Test Management final report and validation payload', () => {
    const staticPath = path.join(tmpDir, 'static.json')
    const intakePath = path.join(tmpDir, 'tm-intake.json')
    const testCommandPath = path.join(tmpDir, 'test-command.txt')
    const testExitCodePath = path.join(tmpDir, 'test-exit-code.txt')
    const artifact = getTestManagementArtifact({
      mode: 'tm-disabled',
      properties: {
        attempt_to_fix: false,
        disabled: true,
        quarantined: false,
      },
      testEvents: [
        getTestEvent({
          finalStatus: 'skip',
          framework: 'mocha',
          name: 'disabled candidate',
          status: 'skip',
          suite: 'test/dd-trace-tm-disabled.spec.js',
          testManagement: {
            disabled: true,
          },
        }),
      ],
    })

    fs.writeFileSync(staticPath, JSON.stringify(getStaticReport(), null, 2))
    fs.writeFileSync(intakePath, JSON.stringify(artifact, null, 2))
    fs.writeFileSync(testCommandPath, 'npm test -- test/dd-trace-tm-disabled.spec.js\n')
    fs.writeFileSync(testExitCodePath, '0\n')

    const report = renderFinalReport({
      static: staticPath,
      intake: intakePath,
      testCommandFile: testCommandPath,
      testExitCodeFile: testExitCodePath,
      testResult: '1 pending',
    })
    const validationPayload = getValidationPayload(report)
    const testManagementCheck = validationPayload.checks.find(check => check.id === 'test-management')
    const disabledStep = testManagementCheck.steps.find(step => step.id === 'disabled')
    const attemptToFixStep = testManagementCheck.steps.find(step => step.id === 'attemptToFix')

    assert.match(report, /Primary funnel stage: Test Management disabled reported/)
    assert.match(report, /Summary:\n- Reporting: OK\n- Test Management: OK/)
    assert.doesNotMatch(report, /Diagnostic answers:/)
    assert.strictEqual(testManagementCheck.status, 'ok')
    assert.strictEqual(disabledStep.status, 'ok')
    assert.strictEqual(disabledStep.evidence.expectedExitCode, '0')
    assert.strictEqual(disabledStep.evidence.actualExitCode, '0')
    assert.deepStrictEqual(disabledStep.evidence.samples, [
      {
        'test.name': 'disabled candidate',
        'test.status': 'skip',
        'test.final_status': 'skip',
        'test.test_management.is_test_disabled': true,
      },
    ])
    assert.strictEqual(attemptToFixStep.status, 'skipped')
  })

  it('renders compact feedback summary from root and advanced reports', () => {
    const basicReportPath = path.join(tmpDir, 'agent-report.json')
    const efdDir = path.join(tmpDir, 'dd-test-optimization-efd')
    const advancedReportPath = path.join(efdDir, 'agent-report.json')
    const finalReportPath = path.join(tmpDir, 'final-report.txt')
    const summaryPath = path.join(tmpDir, 'summary.txt')
    const feedbackPath = path.join(tmpDir, 'feedback.txt')

    fs.mkdirSync(efdDir)
    fs.writeFileSync(
      basicReportPath,
      JSON.stringify(analyzeIntakeArtifact(getCompleteIntakeArtifact('intake.json', 'report.html')), null, 2)
    )
    fs.writeFileSync(
      advancedReportPath,
      JSON.stringify(analyzeIntakeArtifact(getDebugAllIntakeArtifact('efd-intake.json', 'efd-report.html')), null, 2)
    )
    fs.writeFileSync(finalReportPath, 'HTML report: file:///tmp/dd-test-optimization-report.html\n')
    fs.writeFileSync(feedbackPath, 'No actionable feedback.\n')

    const summary = renderFeedbackSummary({
      agentJsonReport: basicReportPath,
      advancedAgentJsonReport: advancedReportPath,
      compactSummary: summaryPath,
      feedbackFile: feedbackPath,
      finalReport: finalReportPath,
    })

    assert.match(summary, /^Runbook completed: yes/m)
    assert.match(summary, /Diagnostic outcome: basic reporting worked/)
    assert.match(
      summary,
      /Basic reporting: Reporting complete, requests=1, event levels=sessions=1, modules=1, suites=1, tests=1/
    )
    assert.match(summary, /EFD: passed, known tests=1, retried new tests=1, distinct retried names=1/)
    assert.match(summary, /Auto Test Retries: passed, failed=1, passed=1, retry passes=1/)
    assert.match(summary, /Reports: file:\/\/\/tmp\/dd-test-optimization-report\.html/)
    assert.match(summary, /Cleanup: temporary EFD removed\/restored, flaky edit restored/)
    assert.match(summary, /Actionable feedback:\n- No actionable feedback\./)
  })

  it('diagnoses an EFD generated test that was not executed by the test runner', () => {
    const diagnosis = getEfdExecutionDiagnostics({
      summary: {
        efd: {
          knownTestsReceived: 4,
          newTests: [],
          requested: true,
          retriedNewTests: 0,
          settingsEnabled: true,
        },
      },
    }, {
      newTestFile: 'packages/example-service/test/dd-trace-efd-debug.test.ts',
      newTestSnippet: [
        "describe('dd trace EFD debug', () => {",
        '  test("dd trace EFD debug temporary test", () => {})',
        '})',
      ].join('\n'),
      testCommand:
        'yarn test packages/example-service/test/utils.node.test.ts ' +
        'packages/example-service/test/dd-trace-efd-debug.test.ts --runInBand',
      testOutput: [
        'PASS node packages/example-service/test/utils.node.test.ts',
        'Ran all test suites matching ' +
          'packages/example-service/test/utils.node.test.ts|' +
          'packages/example-service/test/dd-trace-efd-debug.test.ts.',
      ].join('\n'),
    })

    assert.strictEqual(
      diagnosis.diagnosis,
      'temporary EFD test did not execute; test runner output does not include the generated test name.'
    )
    assert.strictEqual(diagnosis.commandIncludesNewTestFile, true)
    assert.strictEqual(diagnosis.outputMentionsNewTestFile, true)
    assert.strictEqual(diagnosis.outputMentionsNewTestName, false)
  })

  it('combines runbook validation payloads into one validation payload', () => {
    const combined = buildCombinedValidationPayload([
      {
        status: 'ok',
        artifacts: { htmlFileUrl: 'file:///tmp/report.html' },
        checks: [
          { id: 'basic-reporting', name: 'Basic reporting', status: 'ok', steps: [] },
        ],
      },
      {
        status: 'ok',
        checks: [
          { id: 'basic-reporting', name: 'Basic reporting', status: 'ok', steps: [] },
          { id: 'efd-new-test-detection-and-retry', name: 'EFD', status: 'ok', steps: [] },
          { id: 'auto-test-retries', name: 'Auto test retries', status: 'ok', steps: [] },
        ],
      },
      getTestManagementValidationPayload('disabled'),
      getTestManagementValidationPayload('quarantined'),
      getTestManagementValidationPayload('attemptToFix'),
    ], {
      strictTestManagement: true,
    })

    assert.strictEqual(combined.status, 'ok')
    assert.deepStrictEqual(combined.checks.map(check => check.id), [
      'basic-reporting',
      'efd-new-test-detection-and-retry',
      'auto-test-retries',
      'test-management',
    ])

    const testManagementCheck = combined.checks.find(check => check.id === 'test-management')
    assert.strictEqual(testManagementCheck.status, 'ok')
    assert.deepStrictEqual(testManagementCheck.steps.map(step => step.id), [
      'setup-intake',
      'run-tests-disabled',
      'disabled',
      'run-tests-quarantined',
      'quarantined',
      'run-tests-attemptToFix',
      'attemptToFix',
    ])
  })

  it('marks strict combined Test Management validation failed when subchecks are missing', () => {
    const combined = buildCombinedValidationPayload([
      getTestManagementValidationPayload('disabled'),
    ], {
      strictTestManagement: true,
    })
    const testManagementCheck = combined.checks.find(check => check.id === 'test-management')
    const quarantinedStep = testManagementCheck.steps.find(step => step.id === 'quarantined')
    const attemptToFixStep = testManagementCheck.steps.find(step => step.id === 'attemptToFix')

    assert.strictEqual(combined.status, 'failed')
    assert.strictEqual(testManagementCheck.status, 'failed')
    assert.strictEqual(quarantinedStep.status, 'failed')
    assert.strictEqual(attemptToFixStep.status, 'failed')
    assert.strictEqual(
      quarantinedStep.evidence.reason,
      'missing required Test Management subcheck in strict mode'
    )
  })

  it('renders feedback summary output with status sections', () => {
    const cwd = process.cwd()
    const efdDir = path.join(tmpDir, 'dd-test-optimization-efd')

    execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' })
    fs.mkdirSync(efdDir)
    fs.writeFileSync(
      path.join(tmpDir, 'dd-test-optimization-agent-report.json'),
      JSON.stringify(analyzeIntakeArtifact(getCompleteIntakeArtifact('intake.json', 'report.html')), null, 2)
    )
    fs.writeFileSync(
      path.join(efdDir, 'dd-test-optimization-agent-report.json'),
      JSON.stringify(analyzeIntakeArtifact(getDebugAllIntakeArtifact('efd-intake.json', 'efd-report.html')), null, 2)
    )
    fs.writeFileSync(
      path.join(tmpDir, 'dd-test-optimization-final-report.txt'),
      'HTML report: file:///tmp/dd-test-optimization-report.html\n'
    )
    fs.writeFileSync(path.join(tmpDir, 'dd-test-optimization-actionable-feedback.txt'), 'No actionable feedback.\n')
    fs.writeFileSync(path.join(tmpDir, 'dd-test-optimization-preexisting-status.txt'), ' M package.json\n')

    process.chdir(tmpDir)

    try {
      const output = renderFeedbackSummaryOutput(parseFeedbackSummaryArgs([]))

      assert.match(output, /^Runbook completed: yes/m)
      assert.match(output, /Feedback summary path:\n/)
      assert.match(output, /Pre-existing worktree changes:\n M package\.json/)
      assert.match(output, /Current diagnostic artifacts:\n(?:.*\n)*\?\? dd-test-optimization-agent-report\.json/)
      assert.strictEqual(
        fs.existsSync(path.join(tmpDir, 'dd-test-optimization-feedback-summary.txt')),
        true
      )
    } finally {
      process.chdir(cwd)
    }
  })

  it('renders EFD evidence in the final runbook report', () => {
    const staticPath = path.join(tmpDir, 'static.json')
    const intakePath = path.join(tmpDir, 'intake.json')
    const htmlPath = path.join(tmpDir, 'report.html')
    const testCommandPath = path.join(tmpDir, 'test-command.txt')
    const testExitCodePath = path.join(tmpDir, 'test-exit-code.txt')
    const testCommand = 'npm test -- test/sum.spec.js test/dd-trace-efd-debug.spec.js'
    const newTestSnippet = [
      'describe("dd trace EFD debug", () => {',
      '  it("dd trace EFD debug temporary test", () => {',
      '    assert.strictEqual(1 + 1, 2)',
      '  })',
      '})',
    ].join('\n')

    fs.writeFileSync(staticPath, JSON.stringify(getStaticReport(), null, 2))
    fs.writeFileSync(intakePath, JSON.stringify(getEfdIntakeArtifact(intakePath, htmlPath), null, 2))
    fs.writeFileSync(testCommandPath, `${testCommand}\n`)
    fs.writeFileSync(testExitCodePath, '0\n')

    const report = renderFinalReport({
      static: staticPath,
      intake: intakePath,
      testCommandFile: testCommandPath,
      testExitCodeFile: testExitCodePath,
      testResult: '6 passing',
      newTestSnippet,
    })

    assert.match(report, /Primary funnel stage: EFD retried new test/)
    assert.match(report, /- EFD check: known tests endpoint, new-test detection, and retry evidence/)
    assert.match(report, /Summary:\n- Reporting: OK\n- EFD: OK/)
    assert.doesNotMatch(report, /Likely failure cause/)
    assert.match(report, /Early Flake Detection retried a new test for: npm test -- test\/sum\.spec\.js/)

    const validationPayload = getValidationPayload(report)
    const efdCheck = validationPayload.checks.find(check => check.id === 'efd-new-test-detection-and-retry')
    const addNewTestStep = efdCheck.steps.find(step => step.id === 'add-new-test')
    const retryStep = efdCheck.steps.find(step => step.id === 'check-new-test-retried')

    assert.strictEqual(validationPayload.status, 'ok')
    assert.strictEqual(validationPayload.checks.length, 2)
    assert.strictEqual(efdCheck.status, 'ok')
    assert.strictEqual(addNewTestStep.snippet, newTestSnippet)
    assert.strictEqual(retryStep.evidence.retriedNewTests, 1)
    assert.deepStrictEqual(retryStep.evidence.samples, [
      {
        'test.name': 'sum dd trace EFD debug temporary test',
        'test.is_new': true,
        'test.is_retry': true,
        'test.retry_reason': 'early_flake_detection',
      },
    ])
  })

  it('renders Auto Test Retries evidence in the final runbook report', () => {
    const staticPath = path.join(tmpDir, 'static.json')
    const intakePath = path.join(tmpDir, 'intake.json')
    const htmlPath = path.join(tmpDir, 'report.html')
    const testCommandPath = path.join(tmpDir, 'test-command.txt')
    const testExitCodePath = path.join(tmpDir, 'test-exit-code.txt')
    const testCommand = 'npm test -- test/sum.spec.js test/dd-trace-efd-debug.spec.js'
    const newTestSnippet = [
      'describe("dd trace EFD debug", () => {',
      '  it("dd trace EFD debug temporary test", () => {',
      '    assert.strictEqual(1 + 1, 2)',
      '  })',
      '})',
    ].join('\n')
    const flakyTestSnippet = [
      'let ddTraceAutoRetryCounter = 0',
      'it("sum adds positive numbers", () => {',
      '  if (ddTraceAutoRetryCounter++ === 0) throw new Error("dd trace auto retry debug flake")',
      '  assert.strictEqual(1 + 1, 2)',
      '})',
    ].join('\n')

    fs.writeFileSync(staticPath, JSON.stringify(getStaticReport(), null, 2))
    fs.writeFileSync(intakePath, JSON.stringify(getDebugAllIntakeArtifact(intakePath, htmlPath), null, 2))
    fs.writeFileSync(testCommandPath, `${testCommand}\n`)
    fs.writeFileSync(testExitCodePath, '0\n')

    const report = renderFinalReport({
      static: staticPath,
      intake: intakePath,
      testCommandFile: testCommandPath,
      testExitCodeFile: testExitCodePath,
      testResult: '7 passing',
      flakyTestSnippet,
      newTestSnippet,
    })

    assert.match(report, /- Auto Test Retries check: failed and passing retry executions/)
    assert.match(report, /Summary:\n- Reporting: OK\n- EFD: OK\n- Auto Test Retries: OK/)

    const validationPayload = getValidationPayload(report)
    const atrCheck = validationPayload.checks.find(check => check.id === 'auto-test-retries')
    const flakyStep = atrCheck.steps.find(step => step.id === 'make-known-test-flaky')
    const executionsStep = atrCheck.steps.find(step => step.id === 'check-failing-and-passing-executions')
    const retryStep = atrCheck.steps.find(step => step.id === 'check-passing-execution-marked-retry')

    assert.strictEqual(validationPayload.status, 'ok')
    assert.strictEqual(validationPayload.checks.length, 3)
    assert.strictEqual(atrCheck.status, 'ok')
    assert.strictEqual(flakyStep.snippet, flakyTestSnippet)
    assert.strictEqual(executionsStep.evidence.failedExecutions, 1)
    assert.strictEqual(executionsStep.evidence.passedExecutions, 1)
    assert.deepStrictEqual(executionsStep.evidence.failedThenPassedRetryTestNames, ['sum adds positive numbers'])
    assert.deepStrictEqual(executionsStep.evidence.samples, [
      {
        'test.name': 'sum adds positive numbers',
        'test.status': 'fail',
      },
      {
        'test.name': 'sum adds positive numbers',
        'test.status': 'pass',
        'test.is_retry': true,
        'test.retry_reason': 'auto_test_retry',
      },
    ])
    assert.strictEqual(retryStep.evidence.passedRetryTests, 1)
    assert.deepStrictEqual(retryStep.evidence.passedRetryTestNames, ['sum adds positive numbers'])
  })

  it('requires a test command when rendering the final report', () => {
    const staticPath = path.join(tmpDir, 'static.json')
    const intakePath = path.join(tmpDir, 'intake.json')
    const htmlPath = path.join(tmpDir, 'report.html')

    fs.writeFileSync(staticPath, JSON.stringify(getStaticReport(), null, 2))
    fs.writeFileSync(intakePath, JSON.stringify(getCompleteIntakeArtifact(intakePath, htmlPath), null, 2))

    assert.throws(() => {
      renderFinalReport({
        static: staticPath,
        intake: intakePath,
        testExitCode: '0',
      })
    }, /Missing --test-command or --test-command-file/)
  })
})

function getTestManagementValidationPayload (subcheckId) {
  return {
    status: 'ok',
    checks: [
      {
        id: 'test-management',
        name: 'Test Management',
        status: 'ok',
        steps: [
          {
            id: 'setup-intake',
            name: 'Set up Test Management intake',
            status: 'ok',
            evidence: {
              matchedPropertyIdentities: [`identity:${subcheckId}`],
              propertiesEndpointCalled: true,
              propertiesReturned: 1,
              returnedPropertyIdentities: [`identity:${subcheckId}`],
              settingsEnabled: true,
              unmatchedPropertyIdentities: [],
            },
          },
          {
            id: 'run-tests',
            name: 'Run managed test',
            status: 'ok',
            command: `npm test -- ${subcheckId}.spec.js`,
            exitCode: subcheckId === 'attemptToFix' ? '1' : '0',
          },
          { id: 'disabled', name: 'Disabled tests', status: subcheckId === 'disabled' ? 'ok' : 'skipped' },
          { id: 'quarantined', name: 'Quarantined tests', status: subcheckId === 'quarantined' ? 'ok' : 'skipped' },
          {
            id: 'attemptToFix',
            name: 'Attempt-to-fix tests',
            status: subcheckId === 'attemptToFix' ? 'ok' : 'skipped',
          },
        ],
      },
    ],
  }
}

function hasFinding (analysis, stage) {
  return analysis.findings.some(finding => finding.stage === stage)
}

function getValidationPayload (text) {
  const line = text.split('\n').find(line => line.startsWith('Datadog validation: '))
  assert.ok(line)

  const url = line.slice('Datadog validation: '.length)
  assert.match(url, /^ci\/test\/validation#pako:[A-Za-z0-9_-]+$/)

  const encoded = url.slice(url.indexOf('#pako:') + '#pako:'.length)
  const json = zlib.inflateSync(Buffer.from(encoded, 'base64url')).toString('utf8')
  return JSON.parse(json)
}

function getStaticReport () {
  return {
    ddTraceVersion: '6.0.0-pre',
    supportedFrameworks: [
      {
        id: 'mocha',
        name: 'Mocha',
        versionDetections: [
          {
            version: '11.7.6',
          },
        ],
      },
    ],
    results: [
      {
        status: 'error',
        title: 'Missing Test Optimization initialization',
        message: 'No NODE_OPTIONS preload for dd-trace/ci/init was found.',
      },
      {
        status: 'warning',
        title: 'DD_SERVICE was not found',
        message: 'A missing service name makes Test Optimization data harder to find and group.',
        recommendation: 'Set DD_SERVICE in the test job.',
      },
    ],
  }
}

function getUnsupportedJestStaticReport () {
  return {
    ddTraceVersion: '6.0.0-pre',
    supportedFrameworks: [
      {
        id: 'jest',
        name: 'Jest',
        versionDetections: [
          {
            version: '27.5.1',
          },
        ],
      },
    ],
    results: [
      {
        status: 'error',
        title: 'Jest 27.5.1 is not supported',
        message: 'Detected jest@27.5.1 from installed package; supported range is >=28.0.0.',
        recommendation: 'Upgrade Jest to >=28.0.0, or use dd-trace v5 for older Jest versions.',
      },
    ],
  }
}

function getSessionOnlyIntakeArtifact (intakePath, htmlPath) {
  const artifact = getCompleteIntakeArtifact(intakePath, htmlPath)
  artifact.requests[0].payload.events = artifact.requests[0].payload.events
    .filter(event => event.type !== 'test')

  return artifact
}

function getCompleteIntakeArtifact (intakePath, htmlPath) {
  return {
    intake: {
      artifactPath: intakePath,
      htmlReportFileUrl: pathToFileURL(htmlPath).href,
      htmlReportOpenCommand: getExpectedOpenCommand(htmlPath),
      htmlReportPath: htmlPath,
      stoppedAt: '2026-06-04T12:00:00.000Z',
      url: 'http://127.0.0.1:12345',
    },
    requests: [
      {
        category: 'citestcycle',
        payload: {
          metadata: {
            '*': {
              'test.command': 'npm test -- test/sum.spec.js',
            },
          },
          events: [
            {
              type: 'test_session_end',
              content: {
                test_session_id: '1',
              },
            },
            {
              type: 'test_module_end',
              content: {
                test_session_id: '1',
              },
            },
            {
              type: 'test_suite_end',
              content: {
                meta: {
                  'test.suite': 'test/sum.spec.js',
                },
                test_session_id: '1',
              },
            },
            getTestEvent({
              framework: 'mocha',
              name: 'sum adds positive numbers',
              sessionId: '1',
              suite: 'test/sum.spec.js',
            }),
          ],
        },
      },
    ],
  }
}

function getEfdIntakeArtifact (intakePath, htmlPath) {
  return {
    ...getCompleteIntakeArtifact(intakePath, htmlPath),
    intake: {
      ...getCompleteIntakeArtifact(intakePath, htmlPath).intake,
      settingsMode: 'efd',
    },
    requests: [
      {
        category: 'settings',
        payload: {
          data: {
            attributes: {
              branch: 'main',
              repository_url: 'git@example.com:org/repo.git',
              sha: 'abcdef',
            },
          },
        },
      },
      {
        category: 'known_tests',
      },
      {
        category: 'citestcycle',
        payload: {
          metadata: {
            '*': {
              'test.command': 'npm test -- test/sum.spec.js test/dd-trace-efd-debug.spec.js',
            },
          },
          events: [
            { type: 'test_session_end', content: { test_session_id: '1' } },
            { type: 'test_module_end', content: { test_session_id: '1' } },
            {
              type: 'test_suite_end',
              content: {
                meta: {
                  'test.suite': 'test/sum.spec.js',
                },
                test_session_id: '1',
              },
            },
            getTestEvent({
              framework: 'mocha',
              isNew: true,
              isRetry: true,
              name: 'sum dd trace EFD debug temporary test',
              sessionId: '1',
              suite: 'test/sum.spec.js',
            }),
          ],
        },
      },
    ],
    settings: {
      responses: [
        {
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': 3,
            },
          },
          known_tests_enabled: true,
        },
      ],
    },
    knownTests: {
      responses: [
        {
          data: {
            attributes: {
              tests: {
                mocha: {
                  'test/sum.spec.js': ['sum adds positive numbers'],
                },
              },
            },
          },
        },
      ],
    },
  }
}

function getDebugAllIntakeArtifact (intakePath, htmlPath) {
  const artifact = getEfdIntakeArtifact(intakePath, htmlPath)

  artifact.intake.settingsMode = 'debug-all'
  artifact.requests[2].payload.events.push(
    getTestEvent({
      framework: 'mocha',
      name: 'sum adds positive numbers',
      sessionId: '1',
      status: 'fail',
      suite: 'test/sum.spec.js',
    }),
    getTestEvent({
      framework: 'mocha',
      isRetry: true,
      name: 'sum adds positive numbers',
      retryReason: 'auto_test_retry',
      sessionId: '1',
      status: 'pass',
      suite: 'test/sum.spec.js',
    })
  )
  artifact.settings.responses[0].flaky_test_retries_enabled = true
  artifact.settings.responses[0].flaky_test_retries_count = 1

  return artifact
}

function getTestEvent ({
  framework,
  isNew,
  isRetry,
  name,
  finalStatus,
  retryReason = 'early_flake_detection',
  sessionId = '123',
  status,
  suite,
  testManagement,
}) {
  const meta = {
    'test.framework': framework,
    'test.name': name,
    'test.suite': suite,
  }

  if (status) {
    meta['test.status'] = status
  }

  if (finalStatus) {
    meta['test.final_status'] = finalStatus
  }

  if (isNew) {
    meta['test.is_new'] = 'true'
  }

  if (isRetry) {
    meta['test.is_retry'] = 'true'
    meta['test.retry_reason'] = retryReason
  }

  if (testManagement?.disabled) {
    meta['test.test_management.is_test_disabled'] = 'true'
  }

  if (testManagement?.quarantined) {
    meta['test.test_management.is_quarantined'] = 'true'
  }

  if (testManagement?.attemptToFix) {
    meta['test.test_management.is_attempt_to_fix'] = 'true'
  }

  if (testManagement?.attemptToFixPassed !== undefined) {
    meta['test.test_management.attempt_to_fix_passed'] = String(testManagement.attemptToFixPassed)
  }

  return {
    type: 'test',
    content: {
      test_session_id: sessionId,
      meta,
    },
  }
}

function getTestManagementArtifact ({
  mode,
  properties,
  propertyName,
  testEvents,
}) {
  const firstTest = testEvents[0]
  const framework = firstTest.content.meta['test.framework']
  const suite = firstTest.content.meta['test.suite']
  const name = propertyName || firstTest.content.meta['test.name']
  const modules = {
    [framework]: {
      suites: {
        [suite]: {
          tests: {
            [name]: {
              properties,
            },
          },
        },
      },
    },
  }
  const response = {
    data: {
      attributes: {
        modules,
      },
    },
  }

  return {
    intake: {
      settingsMode: mode,
    },
    requests: [
      {
        category: 'settings',
        payload: {
          data: {
            attributes: {
              repository_url: 'git@example.com:org/repo.git',
              sha: 'abcdef',
              branch: 'main',
            },
          },
        },
      },
      {
        category: 'test_management',
        payload: {
          data: {
            attributes: {
              repository_url: 'git@example.com:org/repo.git',
              sha: 'abcdef',
              branch: 'main',
            },
          },
        },
      },
      {
        category: 'citestcycle',
        payload: {
          events: [
            {
              type: 'test_session_end',
              content: {
                test_session_id: '123',
              },
            },
            {
              type: 'test_module_end',
              content: {
                test_session_id: '123',
              },
            },
            {
              type: 'test_suite_end',
              content: {
                test_session_id: '123',
              },
            },
            ...testEvents,
          ],
        },
      },
    ],
    settings: {
      responses: [
        {
          test_management: {
            enabled: true,
            attempt_to_fix_retries: 3,
          },
        },
      ],
    },
    testManagement: {
      responses: [
        {
          request: {},
          response,
        },
      ],
    },
  }
}

function postJson (baseUrl, pathname, payload, callback) {
  postBuffer(baseUrl, pathname, Buffer.from(JSON.stringify(payload)), {
    'Content-Type': 'application/json',
  }, callback)
}

function postJsonResponse (baseUrl, pathname, payload, callback) {
  const url = new URL(pathname, baseUrl)
  const body = Buffer.from(JSON.stringify(payload))
  const req = http.request({
    method: 'POST',
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    headers: {
      'Content-Length': body.length,
      'Content-Type': 'application/json',
    },
  }, (res) => {
    const chunks = []

    res.on('data', chunk => {
      chunks.push(chunk)
    })
    res.once('end', () => {
      try {
        callback(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        callback(error)
      }
    })
  })

  req.once('error', callback)
  req.end(body)
}

function getJson (url, callback) {
  const req = http.get(url, (res) => {
    const chunks = []

    res.on('data', chunk => {
      chunks.push(chunk)
    })

    res.once('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8')
        callback(undefined, res.statusCode, JSON.parse(body))
      } catch (error) {
        callback(error)
      }
    })
  })

  req.once('error', callback)
}

function getExpectedOpenCommand (file) {
  if (process.platform === 'darwin') {
    return [
      `open -a ${shellQuote('Google Chrome')} ${shellQuote(file)}`,
      `open -a Chromium ${shellQuote(file)}`,
      `open -a Safari ${shellQuote(file)}`,
      `open ${shellQuote(file)}`,
    ].join(' || ')
  }

  if (process.platform === 'win32') {
    return [
      `start "" "${file}"`,
      `explorer.exe "${file}"`,
    ].join(' || ')
  }

  return [
    `google-chrome ${shellQuote(file)}`,
    `chromium ${shellQuote(file)}`,
    `chromium-browser ${shellQuote(file)}`,
    `firefox ${shellQuote(file)}`,
    `xdg-open ${shellQuote(file)}`,
  ].join(' || ')
}

function getSimpleJestTestSource (testName) {
  return [
    'describe(\'selected test\', () => {',
    `  test(${JSON.stringify(testName)}, () => {`,
    '    expect(true).toBe(true)',
    '  })',
    '})',
    '',
  ].join('\n')
}

function shellQuote (value) {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`
}

function escapeRegExp (value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function postBuffer (baseUrl, pathname, payload, headers, callback) {
  const url = new URL(pathname, baseUrl)
  const req = http.request({
    method: 'POST',
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    headers: {
      ...headers,
      'Content-Length': payload.length,
    },
  }, (res) => {
    res.resume()
    res.once('end', callback)
  })

  req.once('error', callback)
  req.end(payload)
}
