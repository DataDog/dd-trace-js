'use strict'

const uuid = require('crypto-randomuuid')
const { breakpoints } = require('./state')
const session = require('./session')
const send = require('./send')
const { ackEmitting } = require('./status')
require('./remote_config')
const log = require('../../log')

// The `session.connectToMainThread()` method called inside `session.js` doesn't "register" any active handles, so the
// worker thread will exit with code 0 once when reaches the end of the file unless we do something to keep it alive:
setInterval(() => {}, 1000 * 60)

session.on('Debugger.paused', async ({ params }) => {
  const start = process.hrtime.bigint()
  const timestamp = Date.now()
  const probes = params.hitBreakpoints.map((id) => breakpoints.get(id))
  await session.post('Debugger.resume')
  const diff = process.hrtime.bigint() - start // TODO: Should this be recored as telemetry?

  log.debug(`Finished processing breakpoints - main thread paused for: ${Number(diff) / 1000000} ms`)

  // TODO: Is this the correct way of handling multiple breakpoints hit at the same time?
  for (const probe of probes) {
    await send({
      message: probe.template, // TODO: Process template
      snapshot: {
        id: uuid(),
        timestamp,
        probe: {
          id: probe.id,
          version: probe.version, // TODO: Should this always be 2???
          location: probe.location
        },
        language: 'javascript'
      }
    })

    ackEmitting(probe)
  }
})
