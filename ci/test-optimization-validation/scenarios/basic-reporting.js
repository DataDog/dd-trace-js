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
      ...basicEventEvidence(events),
    }

    if (result.exitCode !== 0) {
      return fail(
        framework,
        scenarioName,
        'The existing test command failed before payload validation could pass.',
        evidence,
        outDir
      )
    }

    if (!hasAllBasicEventTypes(events)) {
      return fail(
        framework,
        scenarioName,
        'The command ran, but not all required test event levels were reported.',
        evidence,
        outDir
      )
    }

    return pass(
      framework,
      scenarioName,
      'Basic reporting emitted session, module, suite, and test events.',
      evidence,
      outDir
    )
  } catch (err) {
    return error(framework, scenarioName, err)
  }
}

module.exports = { runBasicReporting }
