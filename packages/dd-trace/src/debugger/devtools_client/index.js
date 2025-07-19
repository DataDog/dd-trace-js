'use strict'

const { randomUUID } = require('crypto')
const { breakpointToProbes } = require('./state')
const session = require('./session')
const { getLocalStateForCallFrame } = require('./snapshot')
const send = require('./send')
const { getStackFromCallFrames } = require('./state')
const { ackEmitting } = require('./status')
const { parentThreadId } = require('./config')
const { MAX_SNAPSHOTS_PER_SECOND_GLOBALLY } = require('./defaults')
const log = require('./log')
const { version } = require('../../../../../package.json')
const { NODE_MAJOR } = require('../../../../../version')

require('./remote_config')

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
const threadId = parentThreadId === 0 ? `pid:${process.pid}` : `pid:${process.pid};tid:${parentThreadId}`
const threadName = parentThreadId === 0 ? 'MainThread' : `WorkerThread:${parentThreadId}`

const SUPPORT_ARRAY_BUFFER_RESIZE = NODE_MAJOR >= 20
const oneSecondNs = 1_000_000_000n
let globalSnapshotSamplingRateWindowStart = 0n
let snapshotsSampledWithinTheLastSecond = 0

// TODO: Change to const once we drop support for Node.js 18
let snapshotProbeIndexBuffer, snapshotProbeIndex

if (SUPPORT_ARRAY_BUFFER_RESIZE) {
  // TODO: Is a limit of 256 snapshots ever going to be a problem?
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

  let maxReferenceDepth, maxCollectionSize, maxFieldCount, maxLength
  let sampled = false
  let numberOfProbesWithSnapshots = 0
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

      if (probe.captureSnapshot === true) {
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

        snapshotProbeIndex[numberOfProbesWithSnapshots++] = probes.length
        maxReferenceDepth = highestOrUndefined(probe.capture.maxReferenceDepth, maxReferenceDepth)
        maxCollectionSize = highestOrUndefined(probe.capture.maxCollectionSize, maxCollectionSize)
        maxFieldCount = highestOrUndefined(probe.capture.maxFieldCount, maxFieldCount)
        maxLength = highestOrUndefined(probe.capture.maxLength, maxLength)
      }

      if (probe.condition !== undefined) {
        // TODO: Bundle all conditions and evaluate them in a single call
        // TODO: Handle errors
        // eslint-disable-next-line no-await-in-loop
        const { result } = await session.post('Debugger.evaluateOnCallFrame', {
          callFrameId: params.callFrames[0].callFrameId,
          expression: probe.condition,
          returnByValue: true
        })
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
  const { result } = await session.post('Debugger.evaluateOnCallFrame', {
    callFrameId: params.callFrames[0].callFrameId,
    expression: templateExpressions.length === 0
      ? `[${getDDTagsExpression}]`
      : `${templateExpressionSetupCode}[${getDDTagsExpression}${templateExpressions}]`,
    returnByValue: true,
    includeCommandLineAPI: true
  })
  if (result?.subtype === 'error') {
    log.error('[debugger:devtools_client] Error evaluating code on call frame: %s', result?.description)
    evalResults = []
  } else {
    evalResults = result?.value ?? []
  }

  // TODO: Create unique states for each affected probe based on that probes unique `capture` settings (DEBUG-2863)
  const processLocalState = numberOfProbesWithSnapshots !== 0 && await getLocalStateForCallFrame(
    params.callFrames[0],
    { maxReferenceDepth, maxCollectionSize, maxFieldCount, maxLength }
  )

  await session.post('Debugger.resume')
  const diff = process.hrtime.bigint() - start // TODO: Recored as telemetry (DEBUG-2858)

  log.debug(() => `[debugger:devtools_client] Finished processing breakpoints - main thread paused for: ${
    Number(diff) / 1_000_000
  } ms`)

  const logger = {
    // We can safely use `location.file` from the first probe in the array, since all probes hit by `hitBreakpoints`
    // must exist in the same file since the debugger can only pause the main thread in one location.
    name: probes[0].location.file, // name of the class/type/file emitting the snapshot
    method: params.callFrames[0].functionName, // name of the method/function emitting the snapshot
    version,
    thread_id: threadId,
    thread_name: threadName
  }

  const stack = getStackFromCallFrames(params.callFrames)
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
        location: probe.location
      },
      stack,
      language: 'javascript'
    }

    if (probe.captureSnapshot) {
      const state = processLocalState()
      if (state instanceof Error) {
        snapshot.captureError = state.message
      } else if (state) {
        snapshot.captures = {
          lines: { [probe.location.lines[0]]: { locals: state } }
        }
      }
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

function highestOrUndefined (num, max) {
  return num === undefined ? max : Math.max(num, max ?? 0)
}

function processDD (result) {
  return result?.trace_id === undefined ? undefined : result
}
