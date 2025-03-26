'use strict'

const { randomUUID } = require('crypto')
const { breakpoints } = require('./state')
const session = require('./session')
const { getLocalStateForCallFrame } = require('./snapshot')
const send = require('./send')
const { getStackFromCallFrames } = require('./state')
const { ackEmitting, ackError } = require('./status')
const { parentThreadId } = require('./config')
const { MAX_SNAPSHOTS_PER_SECOND_GLOBALLY } = require('./defaults')
const log = require('../../log')
const { version } = require('../../../../../package.json')

require('./remote_config')

// Expression to run on a call frame of the paused thread to get its active trace and span id.
const expression = `
  const context = global.require('dd-trace').scope().active()?.context();
  ({ trace_id: context?.toTraceId(), span_id: context?.toSpanId() })
`

// There doesn't seem to be an official standard for the content of these fields, so we're just populating them with
// something that should be useful to a Node.js developer.
const threadId = parentThreadId === 0 ? `pid:${process.pid}` : `pid:${process.pid};tid:${parentThreadId}`
const threadName = parentThreadId === 0 ? 'MainThread' : `WorkerThread:${parentThreadId}`

const oneSecondNs = 1_000_000_000n
let globalSnapshotSamplingRateWindowStart = 0n
let snapshotsSampledWithinTheLastSecond = 0

// WARNING: The code above the line `await session.post('Debugger.resume')` is highly optimized. Please edit with care!
session.on('Debugger.paused', async ({ params }) => {
  const start = process.hrtime.bigint()

  let maxReferenceDepth, maxCollectionSize, maxFieldCount, maxLength

  // V8 doesn't allow seting more than one breakpoint at a specific location, however, it's possible to set two
  // breakpoints just next to eachother that will "snap" to the same logical location, which in turn will be hit at the
  // same time. E.g. index.js:1:1 and index.js:1:2.
  // TODO: Investigate if it will improve performance to create a fast-path for when there's only a single breakpoint
  let sampled = false
  const length = params.hitBreakpoints.length
  let probes = new Array(length)
  // TODO: Consider reusing this array between pauses and only recreating it if it needs to grow
  const snapshotProbeIndex = new Uint8Array(length) // TODO: Is a limit of 256 probes ever going to be a problem?
  let numberOfProbesWithSnapshots = 0
  for (let i = 0; i < length; i++) {
    const id = params.hitBreakpoints[i]
    const probe = breakpoints.get(id)

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

      snapshotProbeIndex[numberOfProbesWithSnapshots++] = i
      maxReferenceDepth = highestOrUndefined(probe.capture.maxReferenceDepth, maxReferenceDepth)
      maxCollectionSize = highestOrUndefined(probe.capture.maxCollectionSize, maxCollectionSize)
      maxFieldCount = highestOrUndefined(probe.capture.maxFieldCount, maxFieldCount)
      maxLength = highestOrUndefined(probe.capture.maxLength, maxLength)
    }

    sampled = true
    probe.lastCaptureNs = start

    probes[i] = probe
  }

  if (sampled === false) {
    return session.post('Debugger.resume')
  }

  const timestamp = Date.now()
  const dd = await getDD(params.callFrames[0].callFrameId)

  let processLocalState
  if (numberOfProbesWithSnapshots !== 0) {
    try {
      // TODO: Create unique states for each affected probe based on that probes unique `capture` settings (DEBUG-2863)
      processLocalState = await getLocalStateForCallFrame(
        params.callFrames[0],
        { maxReferenceDepth, maxCollectionSize, maxFieldCount, maxLength }
      )
    } catch (err) {
      for (let i = 0; i < numberOfProbesWithSnapshots; i++) {
        ackError(err, probes[snapshotProbeIndex[i]]) // TODO: Ok to continue after sending ackError?
      }
    }
  }

  await session.post('Debugger.resume')
  const diff = process.hrtime.bigint() - start // TODO: Recored as telemetry (DEBUG-2858)

  log.debug(
    '[debugger:devtools_client] Finished processing breakpoints - main thread paused for: %d ms',
    Number(diff) / 1000000
  )

  // Due to the highly optimized algorithm above, the `probes` array might have gaps
  probes = probes.filter((probe) => !!probe)

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
      if (state) {
        snapshot.captures = {
          lines: { [probe.location.lines[0]]: { locals: state } }
        }
      }
    }

    ackEmitting(probe)
    // TODO: Process template (DEBUG-2628)
    send(probe.template, logger, dd, snapshot)
  }
})

function highestOrUndefined (num, max) {
  return num === undefined ? max : Math.max(num, max ?? 0)
}

async function getDD (callFrameId) {
  // TODO: Consider if an `objectGroup` should be used, so it can be explicitly released using
  // `Runtime.releaseObjectGroup`
  const { result } = await session.post('Debugger.evaluateOnCallFrame', {
    callFrameId,
    expression,
    returnByValue: true,
    includeCommandLineAPI: true
  })

  if (result?.value?.trace_id === undefined) {
    if (result?.subtype === 'error') {
      log.error('[debugger:devtools_client] Error getting trace/span id:', result.description)
    }
    return
  }

  return result.value
}
