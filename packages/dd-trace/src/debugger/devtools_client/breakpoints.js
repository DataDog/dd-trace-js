'use strict'

const { getGeneratedPosition } = require('./source-maps')
const session = require('./session')
const compileCondition = require('./condition')
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
  let lineNumber = Number(probe.where.lines[0]) // Tracer doesn't support multiple-line breakpoints
  let columnNumber = 0 // Probes do not contain/support column information

  // Optimize for sending data to /debugger/v1/input endpoint
  probe.location = { file, lines: [String(lineNumber)] }
  delete probe.where

  // Optimize for fast calculations when probe is hit
  const snapshotsPerSecond = probe.sampling?.snapshotsPerSecond ?? (probe.captureSnapshot
    ? MAX_SNAPSHOTS_PER_SECOND_PER_PROBE
    : MAX_NON_SNAPSHOTS_PER_SECOND_PER_PROBE)
  probe.nsBetweenSampling = BigInt(1 / snapshotsPerSecond * 1e9)
  probe.lastCaptureNs = 0n

  // Warning: The code below relies on undocumented behavior of the inspector!
  // It expects that `await session.post('Debugger.enable')` will wait for all loaded scripts to be emitted as
  // `Debugger.scriptParsed` events. If this ever changes, we will have a race condition!
  const script = findScriptFromPartialPath(file)
  if (!script) throw new Error(`No loaded script found for ${file} (probe: ${probe.id}, version: ${probe.version})`)
  const { url, scriptId, sourceMapURL, source } = script

  if (sourceMapURL) {
    ({ line: lineNumber, column: columnNumber } = await getGeneratedPosition(url, source, lineNumber, sourceMapURL))
  }

  log.debug(
    '[debugger:devtools_client] Adding breakpoint at %s:%d:%d (probe: %s, version: %d)',
    url, lineNumber, columnNumber, probe.id, probe.version
  )

  let condition
  try {
    condition = probe.when?.json && compileCondition(probe.when.json)
  } catch (err) {
    throw new Error(`Cannot compile expression: ${probe.when.dsl}`, { cause: err })
  }

  const { breakpointId } = await session.post('Debugger.setBreakpoint', {
    location: {
      scriptId,
      lineNumber: lineNumber - 1, // Beware! lineNumber is zero-indexed
      columnNumber
    },
    condition
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

  if (breakpoints.size === 0) return stop() // return instead of await to reduce number of promises created
}

function start () {
  sessionStarted = true
  return session.post('Debugger.enable') // return instead of await to reduce number of promises created
}

function stop () {
  sessionStarted = false
  return session.post('Debugger.disable') // return instead of await to reduce number of promises created
}
