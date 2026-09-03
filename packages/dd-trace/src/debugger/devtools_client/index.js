'use strict'

const { randomUUID } = require('crypto')
const { workerData: { probeSamplerBuffer } } = require('worker_threads')
const { version } = require('../../../../../package.json')
const processTags = require('../../process-tags')
const { INSPECT_SEGMENT_GLOBAL_PROPERTY } = require('../constants')
const { EVENT_TYPE, INCOMPLETE_REASON } = require('../guardrail-metrics')
const {
  CONDITION_ERROR_FLAG,
  MAX_SAMPLED_PROBES_PER_PAUSE,
  SAMPLED_PROBE_COUNT_INDEX,
  SAMPLED_PROBE_INDEXES_START,
  SAMPLED_PROBE_OVERFLOW_INDEX,
} = require('../probe_sampler_constants')
const { getTakeConditionErrorExpression } = require('./probe_sampler')
const { breakpointToProbes, samplingIndexToProbe } = require('./state')
const { refreshBreakpoint } = require('./breakpoints')
const session = require('./session')
const { getLocalStateForCallFrame, evaluateCaptureExpressions } = require('./snapshot')
const send = require('./send')
const { getStackFromCallFrames } = require('./state')
const { ackEmitting } = require('./status')
const config = require('./config')
const log = require('./log')

require('./remote_config')

/** @typedef {import('node:inspector').Debugger.EvaluateOnCallFrameReturnType} EvaluateOnCallFrameResult */

const templateExpressionSetupCode = 'const $dd_inspectSegment = ' +
  `globalThis[Symbol.for('dd-trace')][${JSON.stringify(INSPECT_SEGMENT_GLOBAL_PROPERTY)}];`

// Expression to run on a call frame of the paused thread to get its active trace and span id.
const getDDTagsExpression = `(() => {
  const context = globalThis._ddtrace.scope().active()?.context();
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
  // Expressions evaluated on the paused frame in one round trip, in the order of `probes`: the evaluated template for
  // probes whose template requires evaluation, and the recorded error for probes paused to report a condition error
  let frameExpressions = ''
  /** @type {Set<object> | undefined} */
  let conditionErrorProbes

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
      const sampledValue = Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_INDEXES_START + j)
      const samplingIndex = sampledValue & ~CONDITION_ERROR_FLAG
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

      if ((sampledValue & CONDITION_ERROR_FLAG) !== 0) {
        // The condition threw, so there's nothing to capture. Only the recorded error is needed from the paused thread.
        conditionErrorProbes ??= new Set()
        conditionErrorProbes.add(probe)
        frameExpressions += `,${getTakeConditionErrorExpression(probe.id)}`
        probes.push(probe)
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
        frameExpressions += `,${probe.template}`
      }

      probes.push(probe)
    }
  }

  // This can happen if sampled probe indexes are inconsistent with the worker state. Those cases are logged above.
  if (probes.length === 0) {
    return session.post('Debugger.resume')
  }

  const timestamp = Date.now()

  let evalResults
  const { result } = /** @type {EvaluateOnCallFrameResult} */ (
    await session.post('Debugger.evaluateOnCallFrame', {
      callFrameId: params.callFrames[0].callFrameId,
      expression: frameExpressions.length === 0
        ? `[${getDDTagsExpression}]`
        : `${templateExpressionSetupCode}[${getDDTagsExpression}${frameExpressions}]`,
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
  /** @type {Awaited<ReturnType<typeof getLocalStateForCallFrame>> | undefined} */
  let localState
  if (numberOfProbesWithSnapshots !== 0) {
    localState = await getLocalStateForCallFrame(
      params.callFrames[0],
      { maxReferenceDepth, maxCollectionSize, maxFieldCount, maxLength },
      start + config.dynamicInstrumentation.captureTimeoutNs
    )
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
  const dd = processDD(evalResults[0]) // the first result is the dd tags, the rest are the frame expression results
  let messageIndex = 1

  // A probe whose capture got permanently disabled during this pause, if any
  let captureDisabledProbe

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

    // Which guardrail bucket the event belongs to, and which capture limits were enforced while producing it. The
    // snapshot module records the reasons, including runtime errors: a fatal error does not necessarily mean one, as
    // the collector also raises a fatal error to disable capture when it hits its large object safety threshold.
    /** @type {number} */
    let eventType = EVENT_TYPE.LOG
    let incompleteReasons = 0

    if (conditionErrorProbes?.has(probe)) {
      // Report the failing condition instead of a probe result, so the user can see why the probe doesn't fire
      const error = evalResults[messageIndex++]
      const message = typeof error === 'string' ? error : 'Unknown evaluation error'
      log.debug('[debugger:devtools_client] Condition of probe %s failed to evaluate: %s', probe.id, message)
      snapshot.evaluationErrors = [{ expr: probe.when.dsl, message }]
      ackEmitting(probe)
      send(message, logger, dd, snapshot,
        config.propagateProcessTags.enabled ? processTags.serialized : undefined,
        probe.captureSnapshot === true || probe.compiledCaptureExpressions !== undefined
          ? EVENT_TYPE.SNAPSHOT
          : EVENT_TYPE.LOG,
        0)
      continue
    }

    if (probe.captureSnapshot) {
      eventType = EVENT_TYPE.SNAPSHOT
      const { processLocalState, fatalErrors, incomplete } = /** @type {NonNullable<typeof localState>} */ (localState)
      if (fatalErrors.length > 0) {
        // There was an error collecting the snapshot for this probe, let's not try again
        probe.captureSnapshot = false
        probe.permanentEvaluationErrors = fatalErrors.map(error => ({
          expr: '',
          message: error.message,
        }))
        captureDisabledProbe ??= probe
      }
      snapshot.captures = {
        lines: { [probe.location.lines[0]]: { locals: processLocalState() } },
      }
      incompleteReasons |= incomplete.reasons
    } else if (probe.compiledCaptureExpressions !== undefined) {
      eventType = EVENT_TYPE.SNAPSHOT
      const expressionResult = /** @type {Map} */ (captureExpressionResults).get(probe.id)
      if (expressionResult) {
        // Handle fatal capture errors - disable capture expressions for this probe permanently
        if (expressionResult.fatalErrors?.length > 0) {
          probe.compiledCaptureExpressions = undefined
          probe.permanentEvaluationErrors = expressionResult.fatalErrors.map(error => ({
            expr: '',
            message: error.message,
          }))
          captureDisabledProbe ??= probe
        }

        snapshot.captures = {
          lines: { [probe.location.lines[0]]: { captureExpressions: expressionResult.processCaptureExpressions() } },
        }
        incompleteReasons |= expressionResult.incomplete.reasons

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
        incompleteReasons |= INCOMPLETE_REASON.RUNTIME_ERROR
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
      config.propagateProcessTags.enabled ? processTags.serialized : undefined,
      eventType, incompleteReasons)
  }

  if (captureDisabledProbe !== undefined) {
    // The breakpoint condition bakes in whether each probe produces snapshots, which decides if a hit counts against
    // the global snapshot rate limit and how a skipped hit is classified. Rebuild it now that this changed. All probes
    // at the location share the breakpoint, so one refresh covers every probe disabled during this pause.
    refreshBreakpoint(captureDisabledProbe).catch((err) => {
      log.error(
        '[debugger:devtools_client] Error refreshing breakpoint after disabling capture for probe %s (version: %s)',
        captureDisabledProbe.id, captureDisabledProbe.version, err
      )
    })
  }
})

function processDD (result) {
  return result?.trace_id === undefined ? undefined : result
}
