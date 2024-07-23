'use strict'

const uuid = require('crypto-randomuuid')
const { breakpoints } = require('./state')
const session = require('./session')
const { getLocalStateForBreakpoint } = require('./snapshot')
const send = require('./send')
const { ackEmitting, ackError } = require('./status')
require('./remote_config')
const log = require('../../log')

// The `session.connectToMainThread()` method called inside `session.js` doesn't "register" any active handles, so the
// worker thread will exit with code 0 once when reaches the end of the file unless we do something to keep it alive:
setInterval(() => {}, 1000 * 60)

session.on('Debugger.paused', async ({ params }) => {
  const start = process.hrtime.bigint()
  const timestamp = Date.now()

  let captureSnapshotForProbe = null
  const probes = params.hitBreakpoints.map((id) => {
    const probe = breakpoints.get(id)
    if (captureSnapshotForProbe === null && probe.captureSnapshot) captureSnapshotForProbe = probe
    return probe
  })

  let state
  if (captureSnapshotForProbe !== null) {
    try {
      state = await getLocalStateForBreakpoint(params)
    } catch (err) {
      ackError(err, captureSnapshotForProbe) // TODO: Ok to continue after sending ackError?
    }
  }

  await session.post('Debugger.resume')
  const diff = process.hrtime.bigint() - start // TODO: Should this be recored as telemetry?

  log.debug(`Finished processing breakpoints - main thread paused for: ${Number(diff) / 1000000} ms`)

  // TODO: Is this the correct way of handling multiple breakpoints hit at the same time?
  for (const probe of probes) {
    const captures = probe.captureSnapshot && state
      ? {
          lines: {
            [probe.location.lines[0]]: {
              // TODO: We can technically split state up in `block` and `locals`. Is `block` a valid key?
              locals: state
            }
          }
        }
      : undefined

    await send({
      message: probe.template, // TODO: Process template
      snapshot: {
        id: uuid(),
        timestamp,
        captures,
        probe: {
          id: probe.id,
          version: probe.version, // TODO: Should this always be 2???
          location: probe.location
        },
        language: 'javascript'
      }
    })

    ackEmitting(probe)

    // TODO: Remove before shipping
    process._rawDebug(
      '\nLocal state:\n' +
      '--------------------------------------------------\n' +
      stateToString(state) +
      '--------------------------------------------------\n' +
      '\nStats:\n' +
      '--------------------------------------------------\n' +
      `   Total state JSON size: ${JSON.stringify(state).length} bytes\n` +
      `Processed was paused for: ${Number(diff) / 1000000} ms\n` +
      '--------------------------------------------------\n'
    )
  }
})

// TODO: Remove this function before shipping
function stateToString (state) {
  if (state === undefined) return '<not captured>'
  let str = ''
  for (const [name, value] of Object.entries(state)) {
    str += `${name}: ${color(value)}\n`
  }
  return str
}

// TODO: Remove this function before shipping
function color (obj) {
  return require('node:util').inspect(obj, { depth: null, colors: true })
}
