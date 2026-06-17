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
      if (result.exitCode !== 0) {
        evidence.commandFailure = summarizeCommandFailure(result, evidence)
      }
      return fail(
        framework,
        scenarioName,
        'The command ran, but not all required test event levels were reported.',
        evidence,
        outDir
      )
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

module.exports = { runBasicReporting }
