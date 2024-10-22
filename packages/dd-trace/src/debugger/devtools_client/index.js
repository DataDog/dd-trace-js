'use strict'

const { randomUUID } = require('crypto')
const { breakpoints } = require('./state')
const session = require('./session')
const { getLocalStateForCallFrame } = require('./snapshot')
const send = require('./send')
const { getScriptUrlFromId } = require('./state')
const { ackEmitting, ackError } = require('./status')
const { parentThreadId } = require('./config')
const log = require('../../log')
const { version } = require('../../../../../package.json')

require('./remote_config')

// There doesn't seem to be an official standard for the content of these fields, so we're just populating them with
// something that should be useful to a Node.js developer.
const threadId = parentThreadId === 0 ? `pid:${process.pid}` : `pid:${process.pid};tid:${parentThreadId}`
const threadName = parentThreadId === 0 ? 'MainThread' : `WorkerThread:${parentThreadId}`

session.on('Debugger.paused', async ({ params }) => {
  const start = process.hrtime.bigint()
  const timestamp = Date.now()

  let captureSnapshotForProbe = null
  let maxReferenceDepth, maxCollectionSize, maxLength
  const probes = params.hitBreakpoints.map((id) => {
    const probe = breakpoints.get(id)
    if (probe.captureSnapshot) {
      captureSnapshotForProbe = probe
      maxReferenceDepth = highestOrUndefined(probe.capture.maxReferenceDepth, maxReferenceDepth)
      maxCollectionSize = highestOrUndefined(probe.capture.maxCollectionSize, maxCollectionSize)
      maxLength = highestOrUndefined(probe.capture.maxLength, maxLength)
    }
    return probe
  })

  let processLocalState
  if (captureSnapshotForProbe !== null) {
    try {
      // TODO: Create unique states for each affected probe based on that probes unique `capture` settings (DEBUG-2863)
      processLocalState = await getLocalStateForCallFrame(
        params.callFrames[0],
        { maxReferenceDepth, maxCollectionSize, maxLength }
      )
    } catch (err) {
      // TODO: This error is not tied to a specific probe, but to all probes with `captureSnapshot: true`.
      // However, in 99,99% of cases, there will be just a single probe, so I guess this simplification is ok?
      ackError(err, captureSnapshotForProbe) // TODO: Ok to continue after sending ackError?
    }
  }

  await session.post('Debugger.resume')
  const diff = process.hrtime.bigint() - start // TODO: Recored as telemetry (DEBUG-2858)

  log.debug(`Finished processing breakpoints - main thread paused for: ${Number(diff) / 1000000} ms`)

  const logger = {
    // We can safely use `location.file` from the first probe in the array, since all probes hit by `hitBreakpoints`
    // must exist in the same file since the debugger can only pause the main thread in one location.
    name: probes[0].location.file, // name of the class/type/file emitting the snapshot
    method: params.callFrames[0].functionName, // name of the method/function emitting the snapshot
    version,
    thread_id: threadId,
    thread_name: threadName
  }

  const stack = params.callFrames.map((frame) => {
    let fileName = getScriptUrlFromId(frame.location.scriptId)
    if (fileName.startsWith('file://')) fileName = fileName.substr(7) // TODO: This might not be required
    return {
      fileName,
      function: frame.functionName,
      lineNumber: frame.location.lineNumber + 1, // Beware! lineNumber is zero-indexed
      columnNumber: frame.location.columnNumber + 1 // Beware! columnNumber is zero-indexed
    }
  })

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

    // TODO: Process template (DEBUG-2628)
    send(probe.template, logger, snapshot, (err) => {
      if (err) log.error(err)
      else ackEmitting(probe)
    })
  }
})

function highestOrUndefined (num, max) {
  return num === undefined ? max : Math.max(num, max ?? 0)
}
