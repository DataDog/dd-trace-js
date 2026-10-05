'use strict'

const createMutex = require('../../../../../vendor/dist/mutexify/promise')
const mutex = createMutex()
const { WORKER_ERROR_REASON } = require('../constants')
const { getGeneratedPosition } = require('./source-maps')
const session = require('./session')
const {
  compile,
  compileSegments,
  getRedactionError,
  getSegmentRedactionErrors,
  templateRequiresEvaluation,
} = require('./condition')
const { MAX_SNAPSHOTS_PER_SECOND_PER_PROBE, MAX_NON_SNAPSHOTS_PER_SECOND_PER_PROBE } = require('./defaults')
const {
  compileBreakpointCondition,
  getRemoveProbeExpression,
  isSnapshotProducingProbe,
} = require('./probe_sampler')
const {
  DEFAULT_MAX_REFERENCE_DEPTH,
  DEFAULT_MAX_COLLECTION_SIZE,
  DEFAULT_MAX_FIELD_COUNT,
  DEFAULT_MAX_LENGTH,
} = require('./snapshot/constants')
const {
  findScriptFromPartialPath,
  clearState,
  locationToBreakpoint,
  breakpointToProbes,
  probeToLocation,
  samplingIndexToProbe,
} = require('./state')
const log = require('./log')
const { ackInstalled } = require('./status')

/**
 * @typedef {import('inspector').Debugger.SetBreakpointReturnType} SetBreakpointResponse
 */

let sessionStarted = false
const probes = new Map()
let nextSamplingIndex = 0
let scriptLoadingStabilizedResolve
const scriptLoadingStabilized = new Promise((resolve) => { scriptLoadingStabilizedResolve = resolve })
const reEvaluate = lock(reEvaluateProbe)

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
    reEvaluate(probe).catch(err => {
      log.error('[debugger:devtools_client] Error re-evaluating probe %s', probe.id, err)
    })
  }
})

module.exports = {
  addBreakpoint: lock(addBreakpoint),
  removeBreakpoint: lock(removeBreakpoint),
  modifyBreakpoint: lock(modifyBreakpoint),
  refreshBreakpoints: lock(refreshBreakpoints),
}

async function addBreakpoint (probe) {
  const previous = probes.get(probe.id)
  if (previous) samplingIndexToProbe.delete(previous.samplingIndex)
  probes.set(probe.id, probe)
  if (!sessionStarted) await start()

  probe.samplingIndex = nextSamplingIndex++
  samplingIndexToProbe.set(probe.samplingIndex, probe)

  const file = probe.where.sourceFile
  let lineNumber = Number(probe.where.lines[0]) // Tracer doesn't support multiple-line breakpoints
  let columnNumber = 0 // Probes do not contain/support column information

  // Optimize for sending data to debugger input endpoint
  probe.location = { file, lines: [String(lineNumber)] }

  // Optimize for fast calculations when probe is hit
  // Re-evaluation reuses the compiled probe after its segments have been discarded.
  if (probe.segments !== undefined) {
    probe.templateRequiresEvaluation = templateRequiresEvaluation(probe.segments)
    if (probe.templateRequiresEvaluation) {
      probe.template = compileSegments(probe.segments)
      probe.templateRedactionErrors = getSegmentRedactionErrors(probe.segments)
    }
    delete probe.segments
  }

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
    )
    const position = await getGeneratedPosition(url, source, lineNumber, sourceMapURL)
    if (position.line !== null && position.column !== null) {
      lineNumber = position.line
      columnNumber = position.column
    } else {
      throw new Error(
        // eslint-disable-next-line @stylistic/max-len
        `Could not find generated position for ${url}:${lineNumber}:${columnNumber} (probe: ${probe.id}, version: ${probe.version})`
      )
    }
  }

  try {
    probe.condition = probe.when?.json && compile(probe.when.json)
  } catch (err) {
    throw new Error(
      `Cannot compile expression: ${probe.when.dsl} (probe: ${probe.id}, version: ${probe.version})`,
      { cause: err }
    )
  }

  if (probe.captureSnapshot) {
    probe.capture = {
      maxReferenceDepth: probe.capture?.maxReferenceDepth ?? DEFAULT_MAX_REFERENCE_DEPTH,
      maxCollectionSize: probe.capture?.maxCollectionSize ?? DEFAULT_MAX_COLLECTION_SIZE,
      maxFieldCount: probe.capture?.maxFieldCount ?? DEFAULT_MAX_FIELD_COUNT,
      maxLength: probe.capture?.maxLength ?? DEFAULT_MAX_LENGTH,
    }
  }

  if (probe.captureExpressions?.length > 0) {
    probe.compiledCaptureExpressions = []
    for (const captureExpr of probe.captureExpressions) {
      const redactionError = getRedactionError(captureExpr.name, captureExpr.expr.json)
      if (redactionError !== undefined) {
        probe.compiledCaptureExpressions.push({ name: captureExpr.name, redactionError })
        continue
      }

      let expression
      try {
        expression = compile(captureExpr.expr.json)
      } catch (err) {
        throw new Error(
          `Cannot compile capture expression: ${captureExpr.name} (probe: ${probe.id}, version: ${probe.version})`,
          { cause: err }
        )
      }

      probe.compiledCaptureExpressions.push({
        name: captureExpr.name,
        expression,
        limits: {
          maxReferenceDepth: captureExpr.capture?.maxReferenceDepth ??
            probe.capture?.maxReferenceDepth ?? DEFAULT_MAX_REFERENCE_DEPTH,
          maxCollectionSize: captureExpr.capture?.maxCollectionSize ??
            probe.capture?.maxCollectionSize ?? DEFAULT_MAX_COLLECTION_SIZE,
          maxFieldCount: captureExpr.capture?.maxFieldCount ??
            probe.capture?.maxFieldCount ?? DEFAULT_MAX_FIELD_COUNT,
          maxLength: captureExpr.capture?.maxLength ??
            probe.capture?.maxLength ?? DEFAULT_MAX_LENGTH,
        },
      })
    }
  }

  // Must be calculated after `compiledCaptureExpressions` has been resolved, since capture-expression probes produce
  // snapshots and therefore default to the snapshot rate.
  //
  // Optimize for fast calculations when probe is hit
  const snapshotsPerSecond = probe.sampling?.snapshotsPerSecond ?? (isSnapshotProducingProbe(probe)
    ? MAX_SNAPSHOTS_PER_SECOND_PER_PROBE
    : MAX_NON_SNAPSHOTS_PER_SECOND_PER_PROBE)
  probe.nsBetweenSampling = BigInt(Math.trunc(1 / snapshotsPerSecond * 1e9))

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
      columnNumber,
    }
    let result
    try {
      result = /** @type {SetBreakpointResponse} */ (await session.post('Debugger.setBreakpoint', {
        location,
        condition: compileBreakpointCondition([probe]),
      }))
    } catch (err) {
      throw new Error(`Error setting breakpoint for probe ${probe.id} (version: ${probe.version})`, { cause: err })
    }
    probeToLocation.set(probe.id, locationKey)
    locationToBreakpoint.set(locationKey, { id: result.breakpointId, location, locationKey })
    breakpointToProbes.set(result.breakpointId, new Map([[probe.id, probe]]))
  }
}

async function removeBreakpoint ({ id }) {
  const probe = probes.get(id)
  const locationKey = probeToLocation.get(id)
  if (!probe && locationKey === undefined) {
    log.error('[debugger:devtools_client] Probe state mismatch reason=probe_state_mismatch',
      new Error(`No local state for probe ${id} requested for removal`))
  }

  probes.delete(id)
  if (probe) samplingIndexToProbe.delete(probe.samplingIndex)
  if (sessionStarted) await removeProbeFromSampler(id)

  // Failed installations remain pending for later script loading, but cancellation must remove them too.
  if (locationKey === undefined) {
    if (sessionStarted && probes.size === 0 && breakpointToProbes.size === 0) await stop()
    return
  }

  const breakpoint = locationToBreakpoint.get(locationKey)
  const probesAtLocation = breakpointToProbes.get(breakpoint.id)

  samplingIndexToProbe.delete(probesAtLocation.get(id)?.samplingIndex)
  probesAtLocation.delete(id)
  probeToLocation.delete(id)

  if (probesAtLocation.size === 0) {
    locationToBreakpoint.delete(locationKey)
    breakpointToProbes.delete(breakpoint.id)
    // TODO: If anything below in this if-block throws, the state is out of sync.
    if (breakpointToProbes.size === 0 && probes.size === 0) {
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
  try {
    await addBreakpoint(probe)
  } catch (err) {
    err.reason ??= WORKER_ERROR_REASON.PROBE_INSTALLATION_FAILED
    err.phase = 'install'
    throw err
  }
}

/**
 * Rebuild the breakpoint conditions at the locations of the given probes from the current state of the probes
 * attached to them.
 *
 * A breakpoint condition bakes in whether each probe produces snapshots, which decides if a hit counts against the
 * global snapshot rate limit and how a skipped hit is classified. That changes when the pause handler permanently
 * disables capture for a probe after a fatal capture error, so the conditions have to be recompiled.
 *
 * Probes sharing a location share a breakpoint, so each location is only refreshed once. A probe that has been removed
 * in the meantime is ignored: its location no longer needs the update.
 *
 * The locations are independent, so one that fails does not stop the others from being refreshed. Any failure is
 * thrown once every location has been attempted.
 *
 * @param {{ id: string }[]} probes - Probes attached to the breakpoints to refresh.
 * @returns {Promise<void>}
 */
async function refreshBreakpoints (probes) {
  if (!sessionStarted) return

  // Breakpoints set next to each other can snap to the same logical location and be hit at the same time, so the
  // probes can be spread over more than one breakpoint.
  const locationKeys = new Set()
  for (const { id } of probes) {
    const locationKey = probeToLocation.get(id)
    if (locationKey !== undefined) locationKeys.add(locationKey)
  }

  /** @type {Error[] | undefined} */
  let errors
  for (const locationKey of locationKeys) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await updateBreakpointInternal(locationToBreakpoint.get(locationKey))
    } catch (err) {
      // Keep going: the remaining locations would otherwise hold on to the condition this refresh exists to replace
      errors ??= []
      errors.push(err)
    }
  }

  if (errors !== undefined) {
    throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Error refreshing breakpoints')
  }
}

/**
 * Replace the breakpoint at a location with one whose condition matches the probes currently attached to it.
 *
 * @param {{ id: string, location: object, locationKey: string }} breakpoint - The breakpoint to replace.
 * @param {object} [probe] - A probe to attach to the breakpoint first, when one is being added.
 * @returns {Promise<void>}
 */
async function updateBreakpointInternal (breakpoint, probe) {
  const probesAtLocation = breakpointToProbes.get(breakpoint.id)

  // If a probe is provided, add it to the breakpoint. If not, it's because we're removing a probe or the probes at the
  // location changed. In all cases the breakpoint condition must be rebuilt to match the probes at the location.
  let context // identifies the update in the error messages below
  if (probe) {
    context = `while adding probe ${probe.id} (version: ${probe.version})`
  } else {
    context = `at ${breakpoint.locationKey}`
  }

  try {
    await session.post('Debugger.removeBreakpoint', { breakpointId: breakpoint.id })
  } catch (err) {
    throw new Error(`Error replacing breakpoint ${context}`, { cause: err })
  }
  breakpointToProbes.delete(breakpoint.id)
  if (probe) {
    probesAtLocation.set(probe.id, probe)
    probeToLocation.set(probe.id, breakpoint.locationKey)
  }
  let result
  try {
    result = /** @type {SetBreakpointResponse} */ (await session.post('Debugger.setBreakpoint', {
      location: breakpoint.location,
      condition: compileBreakpointCondition([...probesAtLocation.values()]),
    }))
  } catch (err) {
    // The old breakpoint was removed, so none of its probes are installed until a retry succeeds.
    locationToBreakpoint.delete(breakpoint.locationKey)
    for (const probe of probesAtLocation.values()) {
      probeToLocation.delete(probe.id)
      samplingIndexToProbe.delete(probe.samplingIndex)
    }
    throw Object.assign(new Error(`Error setting breakpoint ${context}`, { cause: err }), {
      reason: WORKER_ERROR_REASON.PROBE_STATE_MISMATCH,
    })
  }
  breakpoint.id = result.breakpointId
  breakpointToProbes.set(result.breakpointId, probesAtLocation)
}

async function reEvaluateProbe (probe) {
  // A queued retry may belong to a probe that was canceled or replaced before it acquired the mutex.
  if (probes.get(probe.id) !== probe) return

  const script = findScriptFromPartialPath(probe.where.sourceFile)
  log.debug('[debugger:devtools_client] re-evaluating probe %s: %s => %s', probe.id, probe.scriptId, script?.scriptId)

  if (!probeToLocation.has(probe.id) || probe.scriptId !== script?.scriptId) {
    log.debug('[debugger:devtools_client] Better match found for probe %s, re-evaluating', probe.id)
    if (probeToLocation.has(probe.id)) {
      await removeBreakpoint(probe)
    }
    await addBreakpoint(probe)
    ackInstalled(probe)
  }
}

async function start () {
  log.debug('[debugger:devtools_client] Starting debugger')
  await session.post('Debugger.enable')
  sessionStarted = true

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

/**
 * Remove cached sampling state for a probe from the runtime sampler.
 *
 * @param {string} id - The probe id.
 * @returns {Promise<void>}
 */
async function removeProbeFromSampler (id) {
  try {
    await session.post('Runtime.evaluate', {
      expression: getRemoveProbeExpression(id),
    })
  } catch (err) {
    log.error('[debugger:devtools_client] Error removing probe %s from sampler', id, err)
  }
}

function generateLocationKey (scriptId, lineNumber, columnNumber) {
  return `${scriptId}:${lineNumber}:${columnNumber}`
}
