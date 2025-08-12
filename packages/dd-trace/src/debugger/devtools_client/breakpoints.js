'use strict'

const mutex = require('mutexify/promise')()
const { getGeneratedPosition } = require('./source-maps')
const session = require('./session')
const { compile: compileCondition, compileSegments, templateRequiresEvaluation } = require('./condition')
const { MAX_SNAPSHOTS_PER_SECOND_PER_PROBE, MAX_NON_SNAPSHOTS_PER_SECOND_PER_PROBE } = require('./defaults')
const {
  findScriptFromPartialPath,
  clearState,
  locationToBreakpoint,
  breakpointToProbes,
  probeToLocation
} = require('./state')
const log = require('./log')

let sessionStarted = false
const probes = new Map()
let scriptLoadingStabilizedResolve
const scriptLoadingStabilized = new Promise((resolve) => { scriptLoadingStabilizedResolve = resolve })

// There's a race condition when a probe is first added, where the actual script that the probe is supposed to match
// hasn't been loaded yet. This will result in either the probe not being added at all, or an incorrect script being
// matched as the probe target.
//
// Therefore, once new scripts has been loaded, all probes are re-evaluated. If the matched `scriptId` has changed, we
// simply remove the old probe (if it was added to the wrong script) and apply it again.
session.on('scriptLoadingStabilized', () => {
  log.debug('[debugger:devtools_client] Re-evaluating probes')
  scriptLoadingStabilizedResolve()
  for (const probe of probes.values()) {
    reEvaluateProbe(probe).catch(err => {
      log.error('[debugger:devtools_client] Error re-evaluating probe %s', probe.id, err)
    })
  }
})

module.exports = {
  addBreakpoint: lock(addBreakpoint),
  removeBreakpoint: lock(removeBreakpoint),
  modifyBreakpoint: lock(modifyBreakpoint)
}

async function addBreakpoint (probe) {
  if (!sessionStarted) await start()

  probes.set(probe.id, probe)

  const file = probe.where.sourceFile
  let lineNumber = Number(probe.where.lines[0]) // Tracer doesn't support multiple-line breakpoints
  let columnNumber = 0 // Probes do not contain/support column information

  // Optimize for sending data to /debugger/v1/input endpoint
  probe.location = { file, lines: [String(lineNumber)] }

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

  probe.scriptId = scriptId // Needed for detecting script changes during re-evaluation

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
    throw new Error(
      `Cannot compile expression: ${probe.when.dsl} (probe: ${probe.id}, version: ${probe.version})`,
      { cause: err }
    )
  }

  const locationKey = generateLocationKey(scriptId, lineNumber, columnNumber)
  const breakpoint = locationToBreakpoint.get(locationKey)

  log.debug(
    '[debugger:devtools_client] %s breakpoint at %s:%d:%d (probe: %s, version: %d)',
    breakpoint ? 'Updating' : 'Adding', url, lineNumber, columnNumber, probe.id, probe.version
  )

  if (breakpoint) {
    // A breakpoint already exists at this location, so we need to add the probe to the existing breakpoint
    await updateBreakpointInternal(breakpoint, probe)
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
      throw new Error(`Error setting breakpoint for probe ${probe.id} (version: ${probe.version})`, { cause: err })
    }
    probeToLocation.set(probe.id, locationKey)
    locationToBreakpoint.set(locationKey, { id: result.breakpointId, location, locationKey })
    breakpointToProbes.set(result.breakpointId, new Map([[probe.id, probe]]))
  }
}

async function removeBreakpoint ({ id }) {
  if (!sessionStarted) {
    // We should not get in this state, but abort if we do, so the code doesn't fail unexpected
    throw new Error(`Cannot remove probe ${id}: Debugger not started`)
  }
  if (!probeToLocation.has(id)) {
    throw new Error(`Unknown probe id: ${id}`)
  }

  probes.delete(id)

  const locationKey = probeToLocation.get(id)
  const breakpoint = locationToBreakpoint.get(locationKey)
  const probesAtLocation = breakpointToProbes.get(breakpoint.id)

  probesAtLocation.delete(id)
  probeToLocation.delete(id)

  if (probesAtLocation.size === 0) {
    locationToBreakpoint.delete(locationKey)
    breakpointToProbes.delete(breakpoint.id)
    // TODO: If anything below in this if-block throws, the state is out of sync.
    if (breakpointToProbes.size === 0) {
      await stop() // This will also remove the breakpoint
    } else {
      try {
        await session.post('Debugger.removeBreakpoint', { breakpointId: breakpoint.id })
      } catch (err) {
        throw new Error(`Error removing breakpoint for probe ${id}`, { cause: err })
      }
    }
  } else {
    await updateBreakpointInternal(breakpoint)
  }
}

// TODO: Modify existing probe instead of removing it (DEBUG-2817)
async function modifyBreakpoint (probe) {
  await removeBreakpoint(probe)
  await addBreakpoint(probe)
}

async function updateBreakpointInternal (breakpoint, probe) {
  const probesAtLocation = breakpointToProbes.get(breakpoint.id)
  const conditionBeforeNewProbe = compileCompoundCondition([...probesAtLocation.values()])

  // If a probe is provided, add it to the breakpoint. If not, it's because we're removing a probe, but potentially
  // need to update the condition of the breakpoint.
  if (probe) {
    probesAtLocation.set(probe.id, probe)
    probeToLocation.set(probe.id, breakpoint.locationKey)
  }

  const condition = compileCompoundCondition([...probesAtLocation.values()])

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
      throw new Error(`Error setting breakpoint for probe ${probe.id} (version: ${probe.version})`, { cause: err })
    }
    breakpointToProbes.set(result.breakpointId, probesAtLocation)
  }
}

async function reEvaluateProbe (probe) {
  const script = findScriptFromPartialPath(probe.where.sourceFile)
  log.debug('[debugger:devtools_client] re-evaluating probe %s: %s => %s', probe.id, probe.scriptId, script?.scriptId)

  if (probe.scriptId !== script?.scriptId) {
    log.debug('[debugger:devtools_client] Better match found for probe %s, re-evaluating', probe.id)
    if (probeToLocation.has(probe.id)) {
      await removeBreakpoint(probe)
    }
    await addBreakpoint(probe)
  }
}

async function start () {
  sessionStarted = true
  log.debug('[debugger:devtools_client] Starting debugger')
  await session.post('Debugger.enable')

  // Wait until there's a pause in script-loading to avoid accidentally adding probes to incorrect scripts. This is not
  // a guarantee, but best effort.
  log.debug('[debugger:devtools_client] Waiting for script-loading to stabilize')
  await scriptLoadingStabilized
  log.debug('[debugger:devtools_client] Script loading stabilized')
}

function stop () {
  sessionStarted = false
  clearState()
  log.debug('[debugger:devtools_client] Stopping debugger')
  return session.post('Debugger.disable')
}

function lock (fn) {
  return async function (...args) {
    const release = await mutex()
    try {
      return await fn(...args)
    } finally {
      release()
    }
  }
}

// Only if all probes have a condition can we use a compound condition.
// Otherwise, we need to evaluate each probe individually once the breakpoint is hit.
function compileCompoundCondition (probes) {
  if (probes.length === 1) return probes[0].condition

  return probes.every(p => p.condition)
    ? probes
      .map((p) => `(() => { try { return ${p.condition} } catch { return false } })()`)
      .join(' || ')
    : undefined
}

function generateLocationKey (scriptId, lineNumber, columnNumber) {
  return `${scriptId}:${lineNumber}:${columnNumber}`
}
