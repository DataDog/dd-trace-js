'use strict'

const { randomUUID } = require('crypto')
const { workerData: { probeSamplerBuffer } } = require('worker_threads')
const { version } = require('../../../../../package.json')
const processTags = require('../../process-tags')
const { breakpointToProbes, samplingIndexToProbe } = require('./state')
const session = require('./session')
const { getLocalStateForCallFrame, evaluateCaptureExpressions } = require('./snapshot')
const {
  MAX_SAMPLED_PROBES_PER_PAUSE,
  SAMPLED_PROBE_COUNT_INDEX,
  SAMPLED_PROBE_INDEXES_START,
  SAMPLED_PROBE_OVERFLOW_INDEX,
} = require('../probe_sampler_constants')
const send = require('./send')
const { getStackFromCallFrames } = require('./state')
const { ackEmitting } = require('./status')
const config = require('./config')
const log = require('./log')

require('./remote_config')

/** @typedef {import('node:inspector').Debugger.EvaluateOnCallFrameReturnType} EvaluateOnCallFrameResult */

// Expression to run on a call frame of the paused thread to get its active trace and span id.
const templateExpressionSetupCode = `
  const $dd_inspect = global.require('node:util').inspect;
  const $dd_segmentInspectOptions = {
    depth: 0,
    customInspect: false,
    maxArrayLength: 3,
    maxStringLength: 8 * 1024,
    breakLength: Infinity
  };
`
const getDDTagsExpression = `(() => {
  const context = global.require('dd-trace').scope().active()?.context();
  return { trace_id: context?.toTraceId(), span_id: context?.toSpanId() }
})()`

// There doesn't seem to be an official standard for the content of these fields, so we're just populating them with
// something that should be useful to a Node.js developer.
const threadId = config.parentThreadId === 0 ? `pid:${process.pid}` : `pid:${process.pid};tid:${config.parentThreadId}`
const threadName = config.parentThreadId === 0 ? 'MainThread' : `WorkerThread:${config.parentThreadId}`
const sampledProbeIndexes = new Int32Array(probeSamplerBuffer)

// WARNING: The code above the line `await session.post('Debugger.resume')` is highly optimized. Please edit with care!
session.on('Debugger.paused', async ({ params }) => {
  const start = process.hrtime.bigint()

  if (params.reason !== 'other') {
    // This error should not be caught, and should exit the worker thread, effectively stopping the debugging session
    throw new Error(`Unexpected Debugger.paused reason: ${params.reason}`)
  }

  let maxReferenceDepth = 0
  let maxCollectionSize = 0
  let maxFieldCount = 0
  let maxLength = 0
  let numberOfProbesWithSnapshots = 0
  let probesWithCaptureExpressions = false
  const probes = []
  let templateExpressions = ''

  // V8 doesn't allow setting more than one breakpoint at a specific location, however, it's possible to set two
  // breakpoints just next to each other that will "snap" to the same logical location, which in turn will be hit at the
  // same time. E.g. index.js:1:1 and index.js:1:2.
  const numberOfSampledProbeIndexes = Math.min(
    Atomics.exchange(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX, 0),
    MAX_SAMPLED_PROBES_PER_PAUSE
  )
  if (Atomics.exchange(sampledProbeIndexes, SAMPLED_PROBE_OVERFLOW_INDEX, 0) === 1) {
    log.error(
      '[debugger:devtools_client] Too many probes sampled at the same breakpoint location; skipping excess probes'
    )
  }

  // TODO: Investigate if it will improve performance to create a fast-path for when there's only a single breakpoint
  for (let i = 0; i < params.hitBreakpoints.length; i++) {
    const probesAtLocation = breakpointToProbes.get(params.hitBreakpoints[i])

    if (probesAtLocation === undefined) {
      // This might happen due to a race condition where the breakpoint is in the process of being removed
      log.error('[debugger:devtools_client] No probes found for breakpoint %s', params.hitBreakpoints[i])
      continue
    }

    for (let j = 0; j < numberOfSampledProbeIndexes; j++) {
      const samplingIndex = Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_INDEXES_START + j)
      const probe = samplingIndexToProbe.get(samplingIndex)

      if (probe === undefined) {
        log.error('[debugger:devtools_client] No probe found for sampled probe index %d', samplingIndex)
        continue
      }
      if (!probesAtLocation.has(probe.id)) {
        log.error('[debugger:devtools_client] Sampled probe %s was not found at breakpoint %s',
          probe.id, params.hitBreakpoints[i])
        continue
      }

      if (probe.captureSnapshot === true || probe.compiledCaptureExpressions !== undefined) {
        if (probe.captureSnapshot === true) {
          numberOfProbesWithSnapshots++
          maxReferenceDepth = Math.max(probe.capture.maxReferenceDepth, maxReferenceDepth)
          maxCollectionSize = Math.max(probe.capture.maxCollectionSize, maxCollectionSize)
          maxFieldCount = Math.max(probe.capture.maxFieldCount, maxFieldCount)
          maxLength = Math.max(probe.capture.maxLength, maxLength)
        } else {
          probesWithCaptureExpressions = true
        }
      }

      if (probe.templateRequiresEvaluation) {
        templateExpressions += `,${probe.template}`
      }

      probes.push(probe)
    }
  }

  // This can happen if the sampler paused only to report overflow, or if the sampled probe indexes are inconsistent
  // with the worker state. The inconsistent cases are logged above.
  if (probes.length === 0) {
    return session.post('Debugger.resume')
  }

  const timestamp = Date.now()

  let evalResults
  const { result } = /** @type {EvaluateOnCallFrameResult} */ (
    await session.post('Debugger.evaluateOnCallFrame', {
      callFrameId: params.callFrames[0].callFrameId,
      expression: templateExpressions.length === 0
        ? `[${getDDTagsExpression}]`
        : `${templateExpressionSetupCode}[${getDDTagsExpression}${templateExpressions}]`,
      returnByValue: true,
      includeCommandLineAPI: true,
    })
  )
  if (result?.subtype === 'error') {
    log.error('[debugger:devtools_client] Error evaluating code on call frame: %s', result?.description)
    evalResults = []
  } else {
    evalResults = result?.value ?? []
  }

  // TODO: Create unique states for each affected probe based on that probes unique `capture` settings (DEBUG-2863)
  let processLocalState
  /** @type {Error[] | undefined} */
  let fatalSnapshotErrors
  if (numberOfProbesWithSnapshots !== 0) {
    const result = await getLocalStateForCallFrame(
      params.callFrames[0],
      { maxReferenceDepth, maxCollectionSize, maxFieldCount, maxLength },
      start + config.dynamicInstrumentation.captureTimeoutNs
    )
    processLocalState = result.processLocalState
    fatalSnapshotErrors = result.fatalErrors
  }

  // Evaluate capture expressions for probes that have them
  let captureExpressionResults = null
  if (probesWithCaptureExpressions === true) {
    captureExpressionResults = new Map()
    for (const probe of probes) {
      if (probe.compiledCaptureExpressions === undefined) continue
      // eslint-disable-next-line no-await-in-loop
      captureExpressionResults.set(probe.id, await evaluateCaptureExpressions(
        params.callFrames[0],
        probe.compiledCaptureExpressions,
        start + config.dynamicInstrumentation.captureTimeoutNs
      ))
    }
  }

  await session.post('Debugger.resume')
  const diff = process.hrtime.bigint() - start // TODO: Recorded as telemetry (DEBUG-2858)

  // This doesn't measure the overhead of the CDP protocol. The actual pause time is slightly larger.
  // On my machine I'm seeing around 1.7ms of overhead.
  // eslint-disable-next-line eslint-rules/eslint-log-printf-style
  log.debug(() => `[debugger:devtools_client] Finished processing breakpoints - main thread paused for: ~${
    Number(diff) / 1_000_000
  } ms`)

  const logger = {
    // We can safely use `location.file` from the first probe in the array, since all probes hit by `hitBreakpoints`
    // must exist in the same file since the debugger can only pause the main thread in one location.
    name: probes[0].location.file, // name of the class/type/file emitting the snapshot
    method: params.callFrames[0].functionName, // name of the method/function emitting the snapshot
    version,
    thread_id: threadId,
    thread_name: threadName,
  }

  const stack = await getStackFromCallFrames(params.callFrames)
  const dd = processDD(evalResults[0]) // the first result is the dd tags, the rest are the probe template results
  let messageIndex = 1

  // TODO: Send multiple probes in one HTTP request as an array (DEBUG-2848)
  for (const probe of probes) {
    const snapshot = {
      id: randomUUID(),
      timestamp,
      probe: {
        id: probe.id,
        version: probe.version,
        location: probe.location,
      },
      stack,
      language: 'javascript',
    }

    if (probe.captureSnapshot) {
      if (fatalSnapshotErrors && fatalSnapshotErrors.length > 0) {
        // There was an error collecting the snapshot for this probe, let's not try again
        probe.captureSnapshot = false
        probe.permanentEvaluationErrors = fatalSnapshotErrors.map(error => ({
          expr: '',
          message: error.message,
        }))
      }
      snapshot.captures = {
        lines: { [probe.location.lines[0]]: { locals: /** @type {Function} */ (processLocalState)() } },
      }
    } else if (probe.compiledCaptureExpressions !== undefined) {
      const expressionResult = /** @type {Map} */ (captureExpressionResults).get(probe.id)
      if (expressionResult) {
        // Handle fatal capture errors - disable capture expressions for this probe permanently
        if (expressionResult.fatalErrors?.length > 0) {
          probe.compiledCaptureExpressions = undefined
          probe.permanentEvaluationErrors = expressionResult.fatalErrors.map(error => ({
            expr: '',
            message: error.message,
          }))
        }

        snapshot.captures = {
          lines: { [probe.location.lines[0]]: { captureExpressions: expressionResult.processCaptureExpressions() } },
        }

        // Handle transient evaluation errors - include in snapshot for this capture
        if (expressionResult.evaluationErrors?.length > 0) {
          if (snapshot.evaluationErrors === undefined) {
            snapshot.evaluationErrors = expressionResult.evaluationErrors
          } else {
            snapshot.evaluationErrors.push(...expressionResult.evaluationErrors)
          }
        }
      } else {
        log.error('[debugger:devtools_client] Missing capture expression results for probe %s (version: %s)',
          probe.id, probe.version)
        snapshot.evaluationErrors = [{
          expr: '',
          message: 'Internal error: capture expression results not found',
        }]
      }
    }

    if (probe.permanentEvaluationErrors !== undefined) {
      snapshot.evaluationErrors = [...probe.permanentEvaluationErrors]
    }

    let message = ''
    if (probe.templateRequiresEvaluation) {
      const results = evalResults[messageIndex++]
      if (results === undefined) {
        log.error('[debugger:devtools_client] No evaluation results for probe %s', probe.id)
      } else {
        for (const result of results) {
          if (typeof result === 'string') {
            message += result
          } else {
            // If `result` isn't a string, it's an evaluation error object
            if (snapshot.evaluationErrors === undefined) {
              snapshot.evaluationErrors = [result]
            } else {
              snapshot.evaluationErrors.push(result)
            }
            message += `{${result.message}}`
          }
        }
      }
    } else {
      message = probe.template
    }

    ackEmitting(probe)

    send(message, logger, dd, snapshot,
      config.propagateProcessTags.enabled ? processTags.serialized : undefined)
  }
})

function processDD (result) {
  return result?.trace_id === undefined ? undefined : result
}
