'use strict'

const { randomUUID } = require('crypto')
const { breakpoints } = require('./state')
const session = require('./session')
const send = require('./send')
const { getScriptUrlFromId } = require('./state')
const { ackEmitting } = require('./status')
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
  const probes = params.hitBreakpoints.map((id) => breakpoints.get(id))
  await session.post('Debugger.resume')
  const diff = process.hrtime.bigint() - start // TODO: Should this be recored as telemetry?

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

  // TODO: Send multiple probes in one HTTP request as an array
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

    // TODO: Process template
    send(probe.template, logger, snapshot, (err) => {
      if (err) log.error(err)
      else ackEmitting(probe)
    })
  }
})
