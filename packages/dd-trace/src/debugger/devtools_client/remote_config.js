'use strict'

const { workerData: { rcPort } } = require('node:worker_threads')
const { findScriptFromPartialPath, probes, breakpoints } = require('./state')
const session = require('./session')
const { ackReceived, ackInstalled, ackError } = require('./status')
const log = require('../../log')

let sessionStarted = false

// Example log line probe (simplified):
// {
//   id: '100c9a5c-45ad-49dc-818b-c570d31e11d1',
//   version: 0,
//   type: 'LOG_PROBE',
//   where: { sourceFile: 'index.js', lines: ['25'] }, // only use first array element
//   template: 'Hello World 2',
//   segments: [...],
//   captureSnapshot: true,
//   capture: { maxReferenceDepth: 1 },
//   sampling: { snapshotsPerSecond: 1 },
//   evaluateAt: 'EXIT' // only used for method probes
// }
//
// Example log method probe (simplified):
// {
//   id: 'd692ee6d-5734-4df7-9d86-e3bc6449cc8c',
//   version: 0,
//   type: 'LOG_PROBE',
//   where: { typeName: 'index.js', methodName: 'handlerA' },
//   template: 'Executed index.js.handlerA, it took {@duration}ms',
//   segments: [...],
//   captureSnapshot: false,
//   capture: { maxReferenceDepth: 3 },
//   sampling: { snapshotsPerSecond: 5000 },
//   evaluateAt: 'EXIT' // only used for method probes
// }
rcPort.on('message', async ({ action, conf: probe, ackId }) => {
  try {
    await processMsg(action, probe)
    rcPort.postMessage({ ackId })
  } catch (err) {
    rcPort.postMessage({ ackId, error: err })
    ackError(err, probe)
  }
})
rcPort.on('messageerror', (err) => log.error(err))

async function start () {
  sessionStarted = true
  return session.post('Debugger.enable') // return instead of await to reduce number of promises created
}

async function stop () {
  sessionStarted = false
  return session.post('Debugger.disable') // return instead of await to reduce number of promises created
}

async function processMsg (action, probe) {
  log.debug(`Received request to ${action} ${probe.type} probe (id: ${probe.id}, version: ${probe.version})`)

  if (action !== 'unapply') ackReceived(probe)

  if (probe.type !== 'LOG_PROBE') {
    throw new Error(`Unsupported probe type: ${probe.type} (id: ${probe.id}, version: ${probe.version})`)
  }
  if (!probe.where.sourceFile && !probe.where.lines) {
    throw new Error(
      // eslint-disable-next-line @stylistic/js/max-len
      `Unsupported probe insertion point! Only line-based probes are supported (id: ${probe.id}, version: ${probe.version})`
    )
  }

  // This lock is to ensure that we don't get the following race condition:
  //
  // When a breakpoint is being removed and there are no other breakpoints, we disable the debugger by calling
  // `Debugger.disable` to free resources. However, if a new breakpoint is being added around the same time, we might
  // have a race condition where the new breakpoint thinks that the debugger is already enabled because the removal of
  // the other breakpoint hasn't had a chance to call `Debugger.disable` yet. Then once the code that's adding the new
  // breakpoints tries to call `Debugger.setBreakpoint` it fails because in the meantime `Debugger.disable` was called.
  //
  // If the code is ever refactored to not tear down the debugger if there's no active breakpoints, we can safely remove
  // this lock.
  const release = await lock()

  try {
    switch (action) {
      case 'unapply':
        await removeBreakpoint(probe)
        break
      case 'apply':
        await addBreakpoint(probe)
        break
      case 'modify':
        // TODO: Modify existing probe instead of removing it (DEBUG-2817)
        await removeBreakpoint(probe)
        await addBreakpoint(probe)
        break
      default:
        throw new Error(
          // eslint-disable-next-line @stylistic/js/max-len
          `Cannot process probe ${probe.id} (version: ${probe.version}) - unknown remote configuration action: ${action}`
        )
    }
  } finally {
    release()
  }
}

async function addBreakpoint (probe) {
  if (!sessionStarted) await start()

  const file = probe.where.sourceFile
  const line = Number(probe.where.lines[0]) // Tracer doesn't support multiple-line breakpoints

  // Optimize for sending data to /debugger/v1/input endpoint
  probe.location = { file, lines: [String(line)] }
  delete probe.where

  // TODO: Inbetween `await session.post('Debugger.enable')` and here, the scripts are parsed and cached.
  // Maybe there's a race condition here or maybe we're guraenteed that `await session.post('Debugger.enable')` will
  // not continue untill all scripts have been parsed?
  const script = findScriptFromPartialPath(file)
  if (!script) throw new Error(`No loaded script found for ${file} (probe: ${probe.id}, version: ${probe.version})`)
  const [path, scriptId] = script

  log.debug(`Adding breakpoint at ${path}:${line} (probe: ${probe.id}, version: ${probe.version})`)

  const { breakpointId } = await session.post('Debugger.setBreakpoint', {
    location: {
      scriptId,
      lineNumber: line - 1 // Beware! lineNumber is zero-indexed
    }
  })

  probes.set(probe.id, breakpointId)
  breakpoints.set(breakpointId, probe)

  ackInstalled(probe)
}

async function removeBreakpoint ({ id }) {
  if (!sessionStarted) {
    // We should not get in this state, but abort if we do, so the code doesn't fail unexpected
    throw Error(`Cannot remove probe ${id}: Debugger not started`)
  }
  if (!probes.has(id)) {
    throw Error(`Unknown probe id: ${id}`)
  }

  const breakpointId = probes.get(id)
  await session.post('Debugger.removeBreakpoint', { breakpointId })
  probes.delete(id)
  breakpoints.delete(breakpointId)

  if (breakpoints.size === 0) await stop()
}

async function lock () {
  if (lock.p) await lock.p
  let resolve
  lock.p = new Promise((_resolve) => { resolve = _resolve }).then(() => { lock.p = null })
  return resolve
}
