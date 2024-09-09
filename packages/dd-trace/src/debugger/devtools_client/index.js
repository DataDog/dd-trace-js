'use strict'

const uuid = require('crypto-randomuuid')
const { breakpoints } = require('./state')
const session = require('./session')
const send = require('./send')
const { ackEmitting } = require('./status')
require('./remote_config')
const log = require('../../log')

// TODO: What happens if there's no Debugger.paused listener? Will the main thread still pause?
// TODO: What happens if the worker thread crashes before Debugger.paused? Will the main thread resume?
session.on('Debugger.paused', async ({ params }) => {
  const start = process.hrtime.bigint()
  const timestamp = Date.now()
  const probes = params.hitBreakpoints.map((id) => breakpoints.get(id))
  await session.post('Debugger.resume')
  const diff = process.hrtime.bigint() - start // TODO: Should this be recored as telemetry?

  log.debug(`Finished processing breakpoints - main thread paused for: ${Number(diff) / 1000000} ms`)

  const logger = {
    name: probes[0].location.file, // name of the class/type/file emitting the snapshot
    method: params.callFrames[0].functionName, // name of the method/function emitting the snapshot
    version: 2, // version of the snapshot format (not currently used or enforced)
    // TODO: Is it right to use the pid in this case? We don't have access to the thread id
    thread_id: process.pid, // current thread/process id emitting the snapshot
    // TODO: Is `process.title` the best value to use here? Or should we omit `thread_name` entirely?
    thread_name: process.title // name of the current thread emitting the snapshot
  }

  // TODO: Is this the correct way of handling multiple breakpoints hit at the same time?
  for (const probe of probes) {
    await send(
      probe.template, // TODO: Process template
      logger,
      {
        id: uuid(),
        timestamp,
        probe: {
          id: probe.id,
          version: probe.version,
          location: probe.location
        },
        language: 'javascript'
      }
    )

    ackEmitting(probe)
  }
})
