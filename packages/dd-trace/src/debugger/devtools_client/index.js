'use strict'

const uuid = require('crypto-randomuuid')
const { breakpoints } = require('./state')
const session = require('./session')
const send = require('./send')
const { ackEmitting } = require('./status')
require('./remote_config')
const log = require('../../log')

session.on('Debugger.paused', async ({ params }) => {
  const start = process.hrtime.bigint()
  const timestamp = Date.now()
  const probes = params.hitBreakpoints.map((id) => breakpoints.get(id))
  await session.post('Debugger.resume')
  const diff = process.hrtime.bigint() - start // TODO: Should this be recored as telemetry?

  log.debug(`Finished processing breakpoints - main thread paused for: ${Number(diff) / 1000000} ms`)

  // TODO: Is this the correct way of handling multiple breakpoints hit at the same time?
  for (const probe of probes) {
    await send(
      probe.template, // TODO: Process template
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
