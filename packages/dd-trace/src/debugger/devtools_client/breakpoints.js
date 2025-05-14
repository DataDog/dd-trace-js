'use strict'

const lock = require('mutexify/promise')()
const { getGeneratedPosition } = require('./source-maps')
const session = require('./session')
const { compile: compileCondition, compileSegments, templateRequiresEvaluation } = require('./condition')
const { MAX_SNAPSHOTS_PER_SECOND_PER_PROBE, MAX_NON_SNAPSHOTS_PER_SECOND_PER_PROBE } = require('./defaults')
const { findScriptFromPartialPath, locationToBreakpoint, breakpointToProbes, probeToLocation } = require('./state')
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
  probe.templateRequiresEvaluation = templateRequiresEvaluation(probe.segments)
  if (probe.templateRequiresEvaluation) {
    probe.template = compileSegments(probe.segments)
  }
  delete probe.segments

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
    log.debug(
      '[debugger:devtools_client] Translating location using source map for %s:%d:%d (probe: %s, version: %d)',
      file, lineNumber, columnNumber, probe.id, probe.version
    );
    ({ line: lineNumber, column: columnNumber } = await getGeneratedPosition(url, source, lineNumber, sourceMapURL))
  }

  try {
    probe.condition = probe.when?.json && compileCondition(probe.when.json)
  } catch (err) {
    throw new Error(`Cannot compile expression: ${probe.when.dsl}`, { cause: err })
  }

  const release = await lock()

  try {
    const locationKey = generateLocationKey(scriptId, lineNumber, columnNumber)
    const breakpoint = locationToBreakpoint.get(locationKey)

    log.debug(
      '[debugger:devtools_client] %s breakpoint at %s:%d:%d (probe: %s, version: %d)',
      breakpoint ? 'Updating' : 'Adding', url, lineNumber, columnNumber, probe.id, probe.version
    )

    if (breakpoint) {
      // A breakpoint already exists at this location, so we need to add the probe to the existing breakpoint
      await updateBreakpoint(breakpoint, probe)
    } else {
      // No breakpoint exists at this location, so we need to create a new one
      const location = {
        scriptId,
        lineNumber: lineNumber - 1, // Beware! lineNumber is zero-indexed
        columnNumber
      }
      let result
      try {
        result = await session.post('Debugger.setBreakpoint', {
          location,
          condition: probe.condition
        })
      } catch (err) {
        throw new Error(`Error setting breakpoint for probe ${probe.id}`, { cause: err })
      }
      probeToLocation.set(probe.id, locationKey)
      locationToBreakpoint.set(locationKey, { id: result.breakpointId, location, locationKey })
      breakpointToProbes.set(result.breakpointId, new Map([[probe.id, probe]]))
    }
  } finally {
    release()
  }
}

async function removeBreakpoint ({ id }) {
  if (!sessionStarted) {
    // We should not get in this state, but abort if we do, so the code doesn't fail unexpected
    throw Error(`Cannot remove probe ${id}: Debugger not started`)
  }
  if (!probeToLocation.has(id)) {
    throw Error(`Unknown probe id: ${id}`)
  }

  const release = await lock()

  try {
    const locationKey = probeToLocation.get(id)
    const breakpoint = locationToBreakpoint.get(locationKey)
    const probesAtLocation = breakpointToProbes.get(breakpoint.id)

    probesAtLocation.delete(id)
    probeToLocation.delete(id)

    if (probesAtLocation.size === 0) {
      locationToBreakpoint.delete(locationKey)
      breakpointToProbes.delete(breakpoint.id)
      if (breakpointToProbes.size === 0) {
        await stop() // TODO: Will this actually delete the breakpoint?
      } else {
        try {
          await session.post('Debugger.removeBreakpoint', { breakpointId: breakpoint.id })
        } catch (err) {
          throw new Error(`Error removing breakpoint for probe ${id}`, { cause: err })
        }
      }
    } else {
      await updateBreakpoint(breakpoint)
    }
  } finally {
    release()
  }
}

async function updateBreakpoint (breakpoint, probe) {
  const probesAtLocation = breakpointToProbes.get(breakpoint.id)
  const conditionBeforeNewProbe = compileCompoundCondition(Array.from(probesAtLocation.values()))

  // If a probe is provided, add it to the breakpoint. If not, it's because we're removing a probe, but potentially
  // need to update the condtion of the breakpoint.
  if (probe) {
    probesAtLocation.set(probe.id, probe)
    probeToLocation.set(probe.id, breakpoint.locationKey)
  }

  const condition = compileCompoundCondition(Array.from(probesAtLocation.values()))

  if (condition || conditionBeforeNewProbe !== condition) {
    try {
      await session.post('Debugger.removeBreakpoint', { breakpointId: breakpoint.id })
    } catch (err) {
      throw new Error(`Error removing breakpoint for probe ${probe.id}`, { cause: err })
    }
    breakpointToProbes.delete(breakpoint.id)
    let result
    try {
      result = await session.post('Debugger.setBreakpoint', {
        location: breakpoint.location,
        condition
      })
    } catch (err) {
      throw new Error(`Error setting breakpoint for probe ${probe.id}`, { cause: err })
    }
    breakpoint.id = result.breakpointId
    breakpointToProbes.set(result.breakpointId, probesAtLocation)
  }
}

function start () {
  sessionStarted = true
  log.debug('[debugger:devtools_client] Starting debugger')
  return session.post('Debugger.enable')
}

function stop () {
  sessionStarted = false
  log.debug('[debugger:devtools_client] Stopping debugger')
  return session.post('Debugger.disable')
}

// Only if all probes have a condition can we use a compound condition.
// Otherwise, we need to evaluate each probe individually once the breakpoint is hit.
// TODO: Handle errors - if there's 2 conditions, and one fails but the other returns true, we should still pause the
// breakpoint
function compileCompoundCondition (probes) {
  return probes.every(p => p.condition)
    ? probes.map(p => p.condition).filter(Boolean).join(' || ')
    : undefined
}

function generateLocationKey (scriptId, lineNumber, columnNumber) {
  return `${scriptId}:${lineNumber}:${columnNumber}`
}
