'use strict'

const {
  basicEventEvidence,
  error,
  fail,
  hasAllBasicEventTypes,
  pass,
  runInstrumentedCommand,
} = require('./helpers')

async function runBasicReporting ({ framework, intake, out, options }) {
  const scenarioName = 'basic-reporting'
  try {
    intake.configure()
    const { result, events, outDir } = await runInstrumentedCommand({
      framework,
      intake,
      out,
      scenarioName,
      command: framework.existingTestCommand,
      options,
    })

    const evidence = {
      commandExitCode: result.exitCode,
      commandTimedOut: result.timedOut,
      commandDescription: framework.existingTestCommand?.description,
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

      const debugRerun = await runDebugRerun({
        command: framework.existingTestCommand,
        eventLevelFailure,
        framework,
        intake,
        options,
        out,
        result,
      })
      if (debugRerun) {
        evidence.debugRerun = debugRerun.summary
      }

      const failure = fail(
        framework,
        scenarioName,
        eventLevelFailure.summary,
        evidence,
        outDir
      )
      if (debugRerun?.artifacts) {
        failure.artifacts.push(...debugRerun.artifacts)
      }
      return failure
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
    return fail(
      framework,
      scenarioName,
      `${evidence.commandFailure.summary} The exit code did not match the dd-trace-less preflight run.`,
      evidence,
      outDir
    )
  } catch (err) {
    return error(framework, scenarioName, err)
  }
}

async function runDebugRerun ({ command, eventLevelFailure, framework, intake, options, out, result }) {
  if (!shouldRunDebugRerun(eventLevelFailure, result)) return null

  try {
    const debug = await runInstrumentedCommand({
      framework,
      intake,
      out,
      scenarioName: 'basic-reporting-debug',
      command,
      options,
      extraEnv: {
        DD_TRACE_DEBUG: 'true',
        DD_TRACE_LOG_LEVEL: 'debug',
      },
    })

    return {
      summary: summarizeDebugRerun(debug),
      artifacts: getDebugArtifacts(debug.outDir),
    }
  } catch (err) {
    return {
      summary: {
        ran: false,
        error: err && err.message ? err.message : String(err),
      },
    }
  }
}

function shouldRunDebugRerun (eventLevelFailure, result) {
  return result.exitCode === 0 &&
    result.timedOut !== true &&
    eventLevelFailure.kind !== 'vitest-benchmark'
}

function summarizeDebugRerun ({ result, events, outDir }) {
  const output = `${result.stdout}\n${result.stderr}`

  return {
    ran: true,
    commandExitCode: result.exitCode,
    commandTimedOut: result.timedOut,
    artifactDirectory: outDir,
    ...basicEventEvidence(events),
    debugLines: findInterestingLines(output, [
      /dd-trace/i,
      /test optimization/i,
      /ci visibility/i,
      /citestcycle/i,
      /\b(?:error|warn)\b/i,
    ]).slice(0, 20),
    stderrExcerpt: tailInterestingLines(result.stderr),
    stdoutExcerpt: tailInterestingLines(result.stdout),
  }
}

function getDebugArtifacts (outDir) {
  return [
    'command.json',
    'stdout.txt',
    'stderr.txt',
    'events.ndjson',
    'result.json',
  ].map(filename => `${outDir}/${filename}`)
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

function findInterestingLines (output, patterns) {
  return uniqueLines(output.split(/\r?\n/).filter(line => {
    return patterns.some(pattern => pattern.test(line))
  })).slice(0, 8)
}

function tailInterestingLines (output) {
  return output
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '')
    .slice(-12)
}

function uniqueLines (lines) {
  const seen = new Set()
  const unique = []
  for (const line of lines) {
    const normalized = line.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    unique.push(line)
  }
  return unique
}

module.exports = {
  getMissingEventDiagnosis,
  runBasicReporting,
  shouldRunDebugRerun,
}
