'use strict'

const { randomUUID } = require('crypto')
const { version } = require('../../../../../package.json')
const { NODE_MAJOR } = require('../../../../../version')
const processTags = require('../../process-tags')
const { breakpointToProbes } = require('./state')
const session = require('./session')
const { getLocalStateForCallFrame, evaluateCaptureExpressions } = require('./snapshot')
const send = require('./send')
const { getStackFromCallFrames } = require('./state')
const { ackEmitting } = require('./status')
const config = require('./config')
const { MAX_SNAPSHOTS_PER_SECOND_GLOBALLY } = require('./defaults')
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

const SUPPORT_ARRAY_BUFFER_RESIZE = NODE_MAJOR >= 20
const oneSecondNs = 1_000_000_000n
let globalSnapshotSamplingRateWindowStart = 0n
let snapshotsSampledWithinTheLastSecond = 0

// TODO: Change to const once we drop support for Node.js 18
let snapshotProbeIndexBuffer, snapshotProbeIndex

if (SUPPORT_ARRAY_BUFFER_RESIZE) {
  // TODO: Is a limit of 256 snapshots ever going to be a problem?
  // @ts-ignore - ArrayBuffer constructor with maxByteLength is available in Node.js 20+ but not in @types/node@18
  // eslint-disable-next-line n/no-unsupported-features/es-syntax
  snapshotProbeIndexBuffer = new ArrayBuffer(1, { maxByteLength: 256 })
  // TODO: Is a limit of 256 probes ever going to be a problem?
  snapshotProbeIndex = new Uint8Array(snapshotProbeIndexBuffer)
} else {
  snapshotProbeIndex = new Uint8Array(1)
}

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
  let sampled = false
  let numberOfProbesWithSnapshots = 0
  let probesWithCaptureExpressions = false
  const probes = []
  let templateExpressions = ''

  // V8 doesn't allow setting more than one breakpoint at a specific location, however, it's possible to set two
  // breakpoints just next to each other that will "snap" to the same logical location, which in turn will be hit at the
  // same time. E.g. index.js:1:1 and index.js:1:2.
  let numberOfProbesOnBreakpoint = params.hitBreakpoints.length

  // TODO: Investigate if it will improve performance to create a fast-path for when there's only a single breakpoint
  for (let i = 0; i < params.hitBreakpoints.length; i++) {
    const probesAtLocation = breakpointToProbes.get(params.hitBreakpoints[i])

    if (probesAtLocation === undefined) {
      // This might happen due to a race condition where the breakpoint is in the process of being removed
      log.error('[debugger:devtools_client] No probes found for breakpoint %s', params.hitBreakpoints[i])
      continue
    }

    if (probesAtLocation.size !== 1) {
      numberOfProbesOnBreakpoint = numberOfProbesOnBreakpoint + probesAtLocation.size - 1
      if (numberOfProbesOnBreakpoint > snapshotProbeIndex.length) {
        if (SUPPORT_ARRAY_BUFFER_RESIZE) {
          snapshotProbeIndexBuffer.resize(numberOfProbesOnBreakpoint)
        } else {
          snapshotProbeIndex = new Uint8Array(numberOfProbesOnBreakpoint)
        }
      }
    }

    for (const probe of probesAtLocation.values()) {
      if (start - probe.lastCaptureNs < probe.nsBetweenSampling) {
        continue
      }

      if (probe.captureSnapshot === true || probe.compiledCaptureExpressions !== undefined) {
        // This algorithm to calculate number of sampled snapshots within the last second is not perfect, as it's not a
        // sliding window. But it's quick and easy :)
        if (i === 0 && start - globalSnapshotSamplingRateWindowStart > oneSecondNs) {
          snapshotsSampledWithinTheLastSecond = 1
          globalSnapshotSamplingRateWindowStart = start
        } else if (snapshotsSampledWithinTheLastSecond >= MAX_SNAPSHOTS_PER_SECOND_GLOBALLY) {
          continue
        } else {
          snapshotsSampledWithinTheLastSecond++
        }

        if (probe.captureSnapshot === true) {
          snapshotProbeIndex[numberOfProbesWithSnapshots++] = probes.length
          maxReferenceDepth = Math.max(probe.capture.maxReferenceDepth, maxReferenceDepth)
          maxCollectionSize = Math.max(probe.capture.maxCollectionSize, maxCollectionSize)
          maxFieldCount = Math.max(probe.capture.maxFieldCount, maxFieldCount)
          maxLength = Math.max(probe.capture.maxLength, maxLength)
        } else {
          probesWithCaptureExpressions = true
        }
      }

      if (probe.condition !== undefined) {
        // TODO: Bundle all conditions and evaluate them in a single call
        // TODO: Handle errors
        const { result } = /** @type {EvaluateOnCallFrameResult} */ (
          // eslint-disable-next-line no-await-in-loop
          await session.post('Debugger.evaluateOnCallFrame', {
            callFrameId: params.callFrames[0].callFrameId,
            expression: probe.condition,
            returnByValue: true,
          })
        )
        if (result.value !== true) continue
      }

      sampled = true
      probe.lastCaptureNs = start

      if (probe.templateRequiresEvaluation) {
        templateExpressions += `,${probe.template}`
      }

      probes.push(probe)
    }
  }

  if (sampled === false) {
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

    if (config.propagateProcessTags.enabled) {
      snapshot[processTags.DYNAMIC_INSTRUMENTATION_FIELD_NAME] = processTags.tagsObject
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

    send(message, logger, dd, snapshot)
  }
})

function processDD (result) {
  return result?.trace_id === undefined ? undefined : result
}
