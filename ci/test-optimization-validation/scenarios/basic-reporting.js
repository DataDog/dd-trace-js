'use strict'

const fs = require('fs')
const path = require('path')

const {
  basicEventEvidence,
  error,
  fail,
  failWithDebugRerun,
  findInterestingLines,
  hasAllBasicEventTypes,
  pass,
  runInstrumentedCommand,
  tailInterestingLines,
} = require('./helpers')

async function runBasicReporting ({ framework, intake, out, options }) {
  const scenarioName = 'basic-reporting'
  try {
    const command = getBasicReportingCommand(framework)
    intake.configure()
    const { result, events, outDir } = await runInstrumentedCommand({
      framework,
      intake,
      out,
      scenarioName,
      command,
      options,
    })

    const evidence = {
      commandExitCode: result.exitCode,
      commandTimedOut: result.timedOut,
      commandDescription: command?.description,
      forcedLocalCommandUsed: command === framework.forcedLocalCommand,
      commandOutputSummary: summarizeTestOutput(result.stdout, result.stderr),
      manifestNotes: Array.isArray(framework.notes) ? framework.notes : [],
      preflight: summarizePreflight(framework.preflight),
      ...basicEventEvidence(events),
    }

    if (!hasAllBasicEventTypes(events)) {
      const eventLevelFailure = getMissingEventDiagnosis({ framework, result, evidence })
      evidence.eventLevelFailure = eventLevelFailure

      if (result.exitCode !== 0) {
        evidence.commandFailure = summarizeCommandFailure(result, evidence)
      }

      return failBasicReportingWithDebugRerun({
        command,
        configureIntake: () => intake.configure(),
        diagnosis: eventLevelFailure.summary,
        evidence,
        framework,
        intake,
        options,
        out,
        outDir,
        scenarioName,
        skipDebug: !shouldRunDebugRerun(eventLevelFailure, result),
      })
    }

    if (result.exitCode === 0) {
      return pass(
        framework,
        scenarioName,
        'Basic reporting emitted session, module, suite, and test events.',
        evidence,
        outDir
      )
    }

    if (matchesPreflightExitCode(framework.preflight, result.exitCode)) {
      evidence.commandFailure = summarizeCommandFailure(result, evidence)
      evidence.commandExitMatchesPreflight = true
      return pass(
        framework,
        scenarioName,
        'Basic reporting emitted session, module, suite, and test events. ' +
          `The command exited ${result.exitCode}, matching the dd-trace-less preflight run.`,
        evidence,
        outDir
      )
    }

    evidence.commandFailure = summarizeCommandFailure(result, evidence)
    evidence.commandExitMatchesPreflight = false
    return failBasicReportingWithDebugRerun({
      command,
      configureIntake: () => intake.configure(),
      diagnosis: `${evidence.commandFailure.summary} The exit code did not match the dd-trace-less preflight run.`,
      evidence,
      framework,
      intake,
      options,
      out,
      outDir,
      scenarioName,
    })
  } catch (err) {
    return error(framework, scenarioName, err)
  }
}

function getBasicReportingCommand (framework) {
  return framework.forcedLocalCommand || framework.existingTestCommand
}

async function failBasicReportingWithDebugRerun (options) {
  const failure = await failWithDebugRerun(options)
  return refineBasicReportingFailure(failure)
}

function refineBasicReportingFailure (failure) {
  const evidence = failure.evidence || {}
  const diagnosis = getDebugAwareDiagnosis(failure.diagnosis, evidence)
  if (!diagnosis) return failure

  failure.diagnosis = diagnosis.summary
  evidence.localDiagnosis = diagnosis

  if (evidence.eventLevelFailure) {
    evidence.eventLevelFailure = {
      ...evidence.eventLevelFailure,
      summary: diagnosis.summary,
      recommendation: diagnosis.recommendation,
      signals: diagnosis.signals,
    }
  }

  return failure
}

function getDebugAwareDiagnosis (currentDiagnosis, evidence) {
  if (evidence.eventLevelFailure?.kind !== 'no-test-optimization-events') return null

  const debugRerun = evidence.debugRerun
  if (!debugRerun || debugRerun.ran !== true) return null

  const testOutputSummary = summarizeTestOutput(
    (evidence.commandOutputSummary || []).join('\n'),
    (debugRerun.stdoutExcerpt || []).join('\n')
  )
  const testsRan = commandOutputShowsTestsRan(testOutputSummary) ||
    Number(evidence.preflight?.observedTestCount) > 0
  const debugLine = findDebugLine(debugRerun, /dd-trace is not initialized in a package manager/i)
  const noDebugEvents = !hasAnyTestOptimizationEvent(debugRerun)

  if (testsRan && debugLine && noDebugEvents) {
    return {
      kind: 'tests-ran-tracer-not-initialized',
      summary: 'The selected command ran tests, but no Test Optimization events reached the fake intake. ' +
        `The debug rerun printed "${debugLine}", which means the preload executed in the package-manager ` +
        'wrapper without producing Test Optimization events from the test process.',
      recommendation: 'Try a direct test-runner command, or verify NODE_OPTIONS with dd-trace/ci/init reaches the ' +
        'final test process rather than only the package-manager wrapper.',
      signals: getDebugSignals({
        debugLine,
        debugRerun,
        testOutputSummary,
      }),
    }
  }

  if (testsRan && noDebugEvents) {
    return {
      kind: 'tests-ran-no-test-optimization-events',
      summary: 'The selected command ran tests, but no Test Optimization events reached the fake intake. ' +
        'The debug rerun did not emit Test Optimization events either.',
      recommendation: 'Inspect the debug rerun excerpt for tracer initialization or intake connection errors, then ' +
        'verify NODE_OPTIONS with dd-trace/ci/init reaches the final test process.',
      signals: getDebugSignals({
        debugRerun,
        testOutputSummary,
      }),
    }
  }

  if (debugLine && noDebugEvents) {
    return {
      kind: 'tracer-not-initialized',
      summary: `${currentDiagnosis} The debug rerun printed "${debugLine}".`,
      recommendation: 'Verify NODE_OPTIONS with dd-trace/ci/init reaches the final test process.',
      signals: getDebugSignals({
        debugLine,
        debugRerun,
        testOutputSummary,
      }),
    }
  }
}

function shouldRunDebugRerun (eventLevelFailure, result) {
  return result.timedOut !== true &&
    eventLevelFailure.kind !== 'vitest-benchmark' &&
    eventLevelFailure.kind !== 'custom-jest-runner'
}

function matchesPreflightExitCode (preflight, exitCode) {
  return preflight?.ran === true &&
    Number.isInteger(preflight.exitCode) &&
    preflight.exitCode === exitCode
}

function summarizePreflight (preflight) {
  if (!preflight || preflight.ran !== true) {
    return {
      ran: false,
      reason: 'No dd-trace-less preflight result was recorded in the manifest.',
    }
  }

  return {
    ran: true,
    exitCode: preflight.exitCode,
    observedTestCount: preflight.observedTestCount,
    stdoutSummary: preflight.stdoutSummary,
    stderrSummary: preflight.stderrSummary,
  }
}

function summarizeTestOutput (stdout = '', stderr = '') {
  return findInterestingLines(`${stdout}\n${stderr}`, [
    /\b\d+\s+passing\b/i,
    /\b\d+\s+pending\b/i,
    /\b\d+\s+failing\b/i,
    /\b\d+\s+passed\b/i,
    /\b\d+\s+failed\b/i,
    /\btests?\b.*\bpassed\b/i,
    /\btests?\b.*\bfailed\b/i,
    /\bSuccessfully ran target\b.*\btest\b/i,
    /\bsuccess:\s*\d+\b/i,
    /\bTasks:\s*\d+\s+successful\b/i,
  ], 8)
}

function commandOutputShowsTestsRan (lines) {
  return lines.some(line => {
    return /\b\d+\s+(?:passing|passed)\b/i.test(line) ||
      /\btests?\b.*\bpassed\b/i.test(line) ||
      /\bSuccessfully ran target\b.*\btest\b/i.test(line) ||
      /\bsuccess:\s*[1-9]\d*\b/i.test(line) ||
      /\bTasks:\s*[1-9]\d*\s+successful\b/i.test(line)
  })
}

function findDebugLine (debugRerun, pattern) {
  const lines = [
    ...(debugRerun.debugLines || []),
    ...(debugRerun.stdoutExcerpt || []),
    ...(debugRerun.stderrExcerpt || []),
  ]
  return lines.find(line => pattern.test(line))
}

function getDebugSignals ({ debugLine, debugRerun, testOutputSummary }) {
  return {
    debugLine,
    debugLines: debugRerun.debugLines || [],
    stdoutExcerpt: debugRerun.stdoutExcerpt || [],
    stderrExcerpt: debugRerun.stderrExcerpt || [],
    testOutputSummary,
  }
}

function summarizeCommandFailure (result, evidence) {
  const output = `${result.stdout}\n${result.stderr}`
  const buildErrors = findInterestingLines(output, [
    /Could not resolve /,
    /Cannot find module/,
    /Module not found/,
    /Error \[ERR_MODULE_NOT_FOUND\]/,
  ])
  const assertionFailures = findInterestingLines(output, [
    /AssertionError/,
    /Timed out retrying/,
    /^\s+\d+\) /,
  ])
  const testEventsWereReported = evidence.testSessionEvents > 0 &&
    evidence.testModuleEvents > 0 &&
    evidence.testSuiteEvents > 0 &&
    evidence.testEvents > 0
  const summary = getFailureSummary({
    buildErrors,
    assertionFailures,
    exitCode: result.exitCode,
    testEventsWereReported,
    timedOut: result.timedOut,
  })

  return {
    assertionFailures,
    buildErrors,
    stderrExcerpt: tailInterestingLines(result.stderr),
    stdoutExcerpt: tailInterestingLines(result.stdout),
    summary,
    testEventsWereReported,
  }
}

function getMissingEventDiagnosis ({ framework, result, evidence }) {
  const missingLevels = getMissingLevels(evidence)
  const vitestBenchmark = detectVitestBenchmark(framework, result)
  const frameworkSourceTreeRunner = detectFrameworkSourceTreeRunner(framework, result)
  const customJestRunner = detectCustomJestRunner(framework)

  if (vitestBenchmark) {
    return {
      kind: 'vitest-benchmark',
      missingLevels,
      signals: vitestBenchmark.signals,
      summary: 'The selected Vitest command appears to run benchmark mode, not normal tests. ' +
        'Test Optimization reported session/module/suite events, but Vitest benchmark mode did not emit ' +
        'per-test events. Choose a normal Vitest test command such as "vitest run <test-file>" for validation.',
      recommendation: 'Replace the selected command with a normal Vitest test command; do not use `vitest bench` ' +
        'or benchmark-only `*.bench.*` files for Test Optimization validation.',
    }
  }

  if (frameworkSourceTreeRunner && !hasAnyTestOptimizationEvent(evidence)) {
    return {
      kind: 'framework-source-tree-runner',
      missingLevels,
      signals: frameworkSourceTreeRunner.signals,
      summary: 'The selected command ran tests from the test framework source tree, but no Test Optimization ' +
        'events reached the fake intake. This command is not equivalent to a customer project running an ' +
        'installed test-runner package.',
      recommendation: 'Choose a project test command that uses an installed supported framework package. If this ' +
        'repository is the framework itself, treat this entry as not runnable for Test Optimization validation.',
    }
  }

  if (!hasAnyTestOptimizationEvent(evidence)) {
    return {
      kind: 'no-test-optimization-events',
      missingLevels,
      summary: 'No Test Optimization test events reached the fake intake. The tracer may not have initialized ' +
        'in the test process, the selected command may not have executed tests, or the process may not have ' +
        'connected to the local intake.',
      recommendation: 'Check the debug rerun output for tracer initialization, request, or intake connection errors.',
    }
  }

  if (evidence.testEvents === 0) {
    if (customJestRunner) {
      return {
        kind: 'custom-jest-runner',
        missingLevels,
        customTestRunner: customJestRunner,
        signals: customJestRunner.signals,
        summary: `The selected Jest command uses the custom test runner \`${customJestRunner.name}\`. ` +
          'Test Optimization initialized, but this runner did not emit the Jest lifecycle events needed to ' +
          'report individual suites and tests.',
        recommendation: 'Try a standard Jest runner command for validation, or choose a test command that does not ' +
          'use the custom runner. If this project must use the custom runner, dd-trace may need explicit support ' +
          'for that runner before per-test reporting and advanced Test Optimization features can work.',
      }
    }

    return {
      kind: 'missing-test-events',
      missingLevels,
      summary: 'Test Optimization initialized and emitted higher-level events, but per-test events were missing. ' +
        'This usually points to an unsupported runner mode, unsupported framework configuration, or per-test hooks ' +
        'not firing for the selected command.',
      recommendation: 'Choose a smaller standard test command, then inspect the debug rerun output for hook or ' +
        'exporter errors.',
    }
  }

  return {
    kind: 'missing-event-levels',
    missingLevels,
    summary: `The command ran, but these required Test Optimization event levels were missing: ${
      missingLevels.join(', ')
    }.`,
    recommendation: 'Inspect the debug rerun output for tracer initialization, hook, or exporter errors.',
  }
}

function getMissingLevels (evidence) {
  const missing = []
  if (evidence.testSessionEvents === 0) missing.push('test_session_end')
  if (evidence.testModuleEvents === 0) missing.push('test_module_end')
  if (evidence.testSuiteEvents === 0) missing.push('test_suite_end')
  if (evidence.testEvents === 0) missing.push('test')
  return missing
}

function hasAnyTestOptimizationEvent (evidence) {
  return evidence.testSessionEvents > 0 ||
    evidence.testModuleEvents > 0 ||
    evidence.testSuiteEvents > 0 ||
    evidence.testEvents > 0
}

function detectVitestBenchmark (framework, result) {
  if (framework.framework !== 'vitest') return null

  const command = result.command || ''
  const output = `${result.stdout}\n${result.stderr}`
  const signals = []

  if (/\bvitest\s+bench\b/.test(command)) signals.push('command contains `vitest bench`')
  if (/\.bench\.[cm]?[jt]sx?\b/.test(command)) signals.push('command targets a `*.bench.*` file')
  if (/^\s*BENCH\s+Summary\b/m.test(output)) signals.push('stdout contains a Vitest BENCH summary')
  if (/Benchmarking is an experimental feature/.test(output)) {
    signals.push('stderr says Vitest benchmarking is experimental')
  }

  return signals.length > 0 ? { signals } : null
}

function detectCustomJestRunner (framework) {
  if (framework.framework !== 'jest') return null

  const configRunner = findJestRunnerInConfigFiles(framework.project?.configFiles || [])
  if (configRunner && isCustomJestRunner(configRunner.name)) return configRunner

  const packageRunner = findJestRunnerInPackageJson(framework.project?.packageJson)
  if (packageRunner && isCustomJestRunner(packageRunner.name)) return packageRunner
}

function findJestRunnerInConfigFiles (configFiles) {
  for (const configFile of configFiles) {
    const content = readFile(configFile)
    if (!content) continue

    const match = /(?:^|[,{]\s*)runner\s*:\s*['"]([^'"]+)['"]/.exec(content)
    if (!match) continue

    return {
      name: match[1],
      source: configFile,
      sourceType: 'config',
      signals: [
        `Jest config ${configFile} sets runner: ${match[1]}`,
      ],
    }
  }
}

function findJestRunnerInPackageJson (packageJsonPath) {
  if (!packageJsonPath) return

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
    const runner = packageJson.jest?.runner
    if (typeof runner !== 'string' || runner.length === 0) return

    return {
      name: runner,
      source: packageJsonPath,
      sourceType: 'package.json',
      signals: [
        `package.json jest.runner is ${runner}`,
      ],
    }
  } catch {}
}

function isCustomJestRunner (runner) {
  return runner !== 'jest-runner'
}

function detectFrameworkSourceTreeRunner (framework, result) {
  if (framework.framework !== 'mocha') return null

  const projectName = framework.project?.name || ''
  const commandAndOutput = [
    result.command || '',
    result.stdout || '',
    result.stderr || '',
  ].join('\n')
  const signals = []

  if (projectName === 'mocha') {
    signals.push('repository package name is `mocha`')
  }
  if (/\bnode\s+\.\/bin\/mocha\.js\b/.test(commandAndOutput) ||
    /\bnode\s+bin\/mocha\.js\b/.test(commandAndOutput)) {
    signals.push('selected command invokes the repository-local `bin/mocha.js` source-tree runner')
  }
  if (fileExists(framework.project?.root, 'lib/mocha.cjs') && fileExists(framework.project?.root, 'lib/runner.cjs')) {
    signals.push('repository contains Mocha source files `lib/mocha.cjs` and `lib/runner.cjs`')
  }

  return signals.length >= 2 ? { signals } : null
}

function fileExists (root, filename) {
  if (!root) return false

  try {
    return fs.existsSync(path.join(root, filename))
  } catch {
    return false
  }
}

function readFile (filename) {
  try {
    return fs.readFileSync(filename, 'utf8')
  } catch {}
}

function getFailureSummary ({ buildErrors, assertionFailures, exitCode, testEventsWereReported, timedOut }) {
  if (timedOut) {
    return 'The selected test command timed out before payload validation could pass.'
  }

  if (buildErrors.length > 0) {
    if (testEventsWereReported) {
      return 'The selected test command reported Datadog test events, but project setup/build errors made it fail.'
    }

    return 'The selected test command failed during project setup/build before payload validation could pass.'
  }

  if (assertionFailures.length > 0 && testEventsWereReported) {
    return 'The selected test command reported Datadog test events, but the tests failed.'
  }

  if (testEventsWereReported) {
    return `The selected test command reported Datadog test events, but exited ${exitCode}.`
  }

  return `The selected test command exited ${exitCode} before payload validation could pass.`
}

module.exports = {
  getDebugAwareDiagnosis,
  getBasicReportingCommand,
  getMissingEventDiagnosis,
  refineBasicReportingFailure,
  runBasicReporting,
  shouldRunDebugRerun,
  summarizeTestOutput,
}
