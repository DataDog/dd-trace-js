'use strict'

const assert = require('node:assert/strict')
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
  renderAnalysisText,
} = require('../../../../ci/test-optimization-intake-analysis')
const {
  normalizeKnownTests,
  parseArgs,
  startIntake,
  stopIntake,
} = require('../../../../ci/test-optimization-intake')
const {
  renderFinalReport,
} = require('../../../../ci/test-optimization-render-report')
const {
  getNodeOptions,
  getTestResult,
  parseArgs: parseDebugArgs,
  runDebug,
} = require('../../../../ci/test-optimization-debug')

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
          assert.match(analysisText, /\nDatadog validation: https:\/\/app-dev-local\.datadoghq\.com/)

          const validationPayload = getValidationPayload(analysisText)
          assert.deepStrictEqual(validationPayload.result, {
            status: 'ok',
            stage: 'Reporting complete',
          })
          assert.strictEqual(validationPayload.summary.requestCount, 2)
          assert.strictEqual(validationPayload.summary.citestcycle.payloadCount, 1)
          assert.strictEqual(validationPayload.summary.events.counts.test, 1)
          assert.strictEqual(validationPayload.findings[0].stage, 'Reporting complete')

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

  it('parses debug wrapper arguments', () => {
    const knownTestsPath = path.join(tmpDir, 'known-tests.json')
    const knownTests = {
      mocha: {
        'test/sum.spec.js': ['adds numbers'],
      },
    }

    fs.writeFileSync(knownTestsPath, JSON.stringify({ data: { attributes: { tests: knownTests } } }))

    assert.deepStrictEqual(parseDebugArgs([
      '--test-command',
      'npm test -- test/sum.spec.js',
      '--service=ci-debug',
      '--out-dir',
      tmpDir,
      '--ready-timeout-ms=1234',
      '--settings-mode=efd',
      '--known-tests',
      knownTestsPath,
      '--no-clean',
      '--no-open',
    ]), {
      clean: false,
      knownTests,
      open: false,
      outDir: tmpDir,
      readyTimeoutMs: 1234,
      service: 'ci-debug',
      settingsMode: 'efd',
      testCommand: 'npm test -- test/sum.spec.js',
    })
  })

  it('builds NODE_OPTIONS for regular and Vitest test processes', () => {
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
    } finally {
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

  it('runs the debug wrapper and writes artifacts', (done) => {
    const testCommand = 'node report.js'
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
      testCommand,
    }, (error, report) => {
      try {
        process.chdir(cwd)
        assert.ifError(error)
        assert.match(report, /Primary funnel stage: Connected, no settings/)
        assert.match(report, /Requests: 1/)
        assert.match(report, /Consistency checks:\n- Intake URL: ok/)
        assert.match(report, /- Request count: ok \(artifact=1, analyzer=1\)/)
        assert.match(report, /Test result: 2 passing/)
        const htmlReportPath = path.join(tmpDir, 'dd-test-optimization-report.html')

        assert.match(report, new RegExp(`HTML report path: ${escapeRegExp(htmlReportPath)}`))
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
        assert.match(
          fs.readFileSync(path.join(tmpDir, 'dd-test-optimization-env.txt'), 'utf8'),
          /DD_API_KEY=debug\nDD_SERVICE=ci-debug\n/
        )
        assert.match(
          fs.readFileSync(path.join(tmpDir, 'dd-test-optimization-env.txt'), 'utf8'),
          /NODE_OPTIONS=-r dd-trace\/ci\/init\n/
        )
        assert.ok(fs.existsSync(path.join(tmpDir, 'dd-test-optimization-final-report.txt')))
        assert.ok(fs.existsSync(path.join(tmpDir, 'dd-test-optimization-agent-report.json')))
        done()
      } catch (assertionError) {
        process.chdir(cwd)
        done(assertionError)
      }
    })
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
    assert.match(report, /\nDatadog validation: https:\/\/app-dev-local\.datadoghq\.com/)
    assert.match(report, /Primary funnel stage: Reporting complete/)
    assert.match(report, /Scope:\n- Selected test subset only\./)
    assert.match(report, /- Framework: Mocha 11\.7\.6/)
    assert.match(report, /- Test exit code: 0/)
    assert.match(report, /- Test result: 3 passing/)
    assert.match(report, /Consistency checks:\n- Intake URL: ok/)
    assert.match(report, /- Request count: ok \(artifact=1, analyzer=1\)/)
    assert.match(report, /Test command used:\nnpm test -- test\/sum\.spec\.js/)
    assert.match(report, /DD_API_KEY=debug/)
    assert.match(report, /Expected for this live run; Step 4 injected NODE_OPTIONS="-r dd-trace\/ci\/init"/)
    assert.match(report, /Add NODE_OPTIONS="-r dd-trace\/ci\/init" to the CI job/)
    assert.match(report, /Set DD_SERVICE to the service name used for Test Optimization grouping/)
    assert.match(report, /What this proves:/)
    assert.match(report, /Diagnostic answers:/)
    assert.match(
      report,
      /Does dd-trace\/ci\/init reach the test process through NODE_OPTIONS\? yes; inferred from citestcycle/
    )
    assert.match(report, /Final report: /)
    assert.match(report, /Agent JSON report: /)

    const validationPayload = getValidationPayload(report)
    assert.deepStrictEqual(validationPayload.result, {
      status: 'ok',
      stage: 'Reporting complete',
    })
    assert.strictEqual(validationPayload.static.ddTraceVersion, '6.0.0-pre')
    assert.deepStrictEqual(validationPayload.static.frameworks, [
      {
        id: 'mocha',
        name: 'Mocha',
        version: '11.7.6',
      },
    ])
    assert.strictEqual(validationPayload.test.command, testCommand)
    assert.strictEqual(validationPayload.test.exitCode, '0')
    assert.strictEqual(validationPayload.test.result, '3 passing')
    assert.strictEqual(validationPayload.artifacts.htmlFileUrl, pathToFileURL(htmlPath).href)
    assert.strictEqual(validationPayload.env.find(entry => entry.key === 'DD_API_KEY').value, 'debug')
  })

  it('renders EFD evidence in the final runbook report', () => {
    const staticPath = path.join(tmpDir, 'static.json')
    const intakePath = path.join(tmpDir, 'intake.json')
    const htmlPath = path.join(tmpDir, 'report.html')
    const testCommandPath = path.join(tmpDir, 'test-command.txt')
    const testExitCodePath = path.join(tmpDir, 'test-exit-code.txt')
    const testCommand = 'npm test -- test/sum.spec.js'

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
    })

    assert.match(report, /Primary funnel stage: EFD retried new test/)
    assert.match(report, /- EFD check: known tests endpoint, new-test detection, and retry evidence/)
    assert.match(report, /- EFD settings enabled: yes/)
    assert.match(report, /- Known tests requested: yes/)
    assert.match(report, /- Known tests received: 1/)
    assert.match(report, /- New tests observed: 1/)
    assert.match(report, /- Retried new tests: 1/)
    assert.match(report, /Early Flake Detection retried a new test for: npm test -- test\/sum\.spec\.js/)
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

function hasFinding (analysis, stage) {
  return analysis.findings.some(finding => finding.stage === stage)
}

function getValidationPayload (text) {
  const line = text.split('\n').find(line => line.startsWith('Datadog validation: '))
  assert.ok(line)

  const url = line.slice('Datadog validation: '.length)
  assert.match(url, /^https:\/\/app-dev-local\.datadoghq\.com\/ci\/test\/validation#pako:[A-Za-z0-9_-]+$/)

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
          events: [
            { type: 'test_session_end', content: { test_session_id: '1' } },
            { type: 'test_module_end', content: { test_session_id: '1' } },
            { type: 'test_suite_end', content: { test_session_id: '1' } },
            { type: 'test', content: { test_session_id: '1' } },
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
          events: [
            { type: 'test_session_end', content: { test_session_id: '1' } },
            { type: 'test_module_end', content: { test_session_id: '1' } },
            { type: 'test_suite_end', content: { test_session_id: '1' } },
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

function getTestEvent ({ framework, isNew, isRetry, name, sessionId = '123', suite }) {
  const meta = {
    'test.framework': framework,
    'test.name': name,
    'test.suite': suite,
  }

  if (isNew) {
    meta['test.is_new'] = 'true'
  }

  if (isRetry) {
    meta['test.is_retry'] = 'true'
    meta['test.retry_reason'] = 'early_flake_detection'
  }

  return {
    type: 'test',
    content: {
      test_session_id: sessionId,
      meta,
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
