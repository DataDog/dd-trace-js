'use strict'

const session = require('./session')
const { MAX_SNAPSHOTS_PER_SECOND_PER_PROBE, MAX_NON_SNAPSHOTS_PER_SECOND_PER_PROBE } = require('./defaults')
const { findScriptFromPartialPath, probes, breakpoints } = require('./state')
const log = require('../../log')

let sessionStarted = false

module.exports = {
  addBreakpoint,
  removeBreakpoint
}

async function addBreakpoint (probe) {
  if (!sessionStarted) await start()

  const file = probe.where.sourceFile
  const line = Number(probe.where.lines[0]) // Tracer doesn't support multiple-line breakpoints

  // Optimize for sending data to /debugger/v1/input endpoint
  probe.location = { file, lines: [String(line)] }
  delete probe.where

  // Optimize for fast calculations when probe is hit
  const snapshotsPerSecond = probe.sampling?.snapshotsPerSecond ?? (probe.captureSnapshot
    ? MAX_SNAPSHOTS_PER_SECOND_PER_PROBE
    : MAX_NON_SNAPSHOTS_PER_SECOND_PER_PROBE)
  probe.nsBetweenSampling = BigInt(1 / snapshotsPerSecond * 1e9)
  probe.lastCaptureNs = 0n

  // TODO: Inbetween `await session.post('Debugger.enable')` and here, the scripts are parsed and cached.
  // Maybe there's a race condition here or maybe we're guraenteed that `await session.post('Debugger.enable')` will
  // not continue untill all scripts have been parsed?
  const script = findScriptFromPartialPath(file)
  if (!script) throw new Error(`No loaded script found for ${file} (probe: ${probe.id}, version: ${probe.version})`)
  const [path, scriptId] = script

  log.debug(
    '[debugger:devtools_client] Adding breakpoint at %s:%d (probe: %s, version: %d)',
    path, line, probe.id, probe.version
  )

  const { breakpointId } = await session.post('Debugger.setBreakpoint', {
    location: {
      scriptId,
      lineNumber: line - 1 // Beware! lineNumber is zero-indexed
    }
  })

  probes.set(probe.id, breakpointId)
  breakpoints.set(breakpointId, probe)
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

async function start () {
  sessionStarted = true
  return session.post('Debugger.enable') // return instead of await to reduce number of promises created
}

async function stop () {
  sessionStarted = false
  return session.post('Debugger.disable') // return instead of await to reduce number of promises created
}
