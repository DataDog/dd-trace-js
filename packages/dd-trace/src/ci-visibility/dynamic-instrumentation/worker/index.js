'use strict'
const path = require('path')
const {
  workerData: {
    breakpointSetChannel,
    breakpointHitChannel,
    breakpointRemoveChannel
  }
} = require('worker_threads')
const { randomUUID } = require('crypto')
const sourceMap = require('source-map')

// TODO: move debugger/devtools_client/session to common place
const session = require('../../../debugger/devtools_client/session')
// TODO: move debugger/devtools_client/snapshot to common place
const { getLocalStateForCallFrame } = require('../../../debugger/devtools_client/snapshot')
// TODO: move debugger/devtools_client/state to common place
const {
  findScriptFromPartialPath,
  getStackFromCallFrames
} = require('../../../debugger/devtools_client/state')
const log = require('../../../log')

let sessionStarted = false

const breakpointIdToProbe = new Map()
const probeIdToBreakpointId = new Map()

session.on('Debugger.paused', async ({ params: { hitBreakpoints: [hitBreakpoint], callFrames } }) => {
  const probe = breakpointIdToProbe.get(hitBreakpoint)
  if (!probe) {
    log.warn(`No probe found for breakpoint ${hitBreakpoint}`)
    return session.post('Debugger.resume')
  }

  const stack = getStackFromCallFrames(callFrames)

  const getLocalState = await getLocalStateForCallFrame(callFrames[0])

  await session.post('Debugger.resume')

  const snapshot = {
    id: randomUUID(),
    timestamp: Date.now(),
    probe: {
      id: probe.id,
      version: '0',
      location: probe.location
    },
    stack,
    language: 'javascript'
  }

  const state = getLocalState()
  if (state) {
    snapshot.captures = {
      lines: { [probe.location.lines[0]]: { locals: state } }
    }
  }

  breakpointHitChannel.postMessage({ snapshot })
})

breakpointRemoveChannel.on('message', async (probeId) => {
  await removeBreakpoint(probeId)
  breakpointRemoveChannel.postMessage(probeId)
})

breakpointSetChannel.on('message', async (probe) => {
  await addBreakpoint(probe)
  breakpointSetChannel.postMessage(probe.id)
})

async function removeBreakpoint (probeId) {
  if (!sessionStarted) {
    // We should not get in this state, but abort if we do, so the code doesn't fail unexpected
    throw Error(`Cannot remove probe ${probeId}: Debugger not started`)
  }

  const breakpointId = probeIdToBreakpointId.get(probeId)
  if (!breakpointId) {
    throw Error(`Unknown probe id: ${probeId}`)
  }
  await session.post('Debugger.removeBreakpoint', { breakpointId })
  probeIdToBreakpointId.delete(probeId)
  breakpointIdToProbe.delete(breakpointId)
}

async function addBreakpoint (probe) {
  if (!sessionStarted) await start()
  const { file, line } = probe

  probe.location = { file, lines: [String(line)] }

  const script = findScriptFromPartialPath(file)
  if (!script) {
    log.error(`No loaded script found for ${file}`)
    throw new Error(`No loaded script found for ${file}`)
  }

  const [path, scriptId, sourceMapURL] = script

  log.warn(`Adding breakpoint at ${path}:${line}`)

  let lineNumber = line

  if (sourceMapURL && sourceMapURL.startsWith('data:')) {
    try {
      lineNumber = await processScriptWithInlineSourceMap({ file, line, sourceMapURL })
    } catch (err) {
      log.error('Error processing script with inline source map', err)
    }
  }

  try {
    const { breakpointId } = await session.post('Debugger.setBreakpoint', {
      location: {
        scriptId,
        lineNumber: lineNumber - 1
      }
    })

    breakpointIdToProbe.set(breakpointId, probe)
    probeIdToBreakpointId.set(probe.id, breakpointId)
  } catch (e) {
    log.error(`Error setting breakpoint at ${path}:${line}:`, e)
  }
}

function start () {
  sessionStarted = true
  return session.post('Debugger.enable') // return instead of await to reduce number of promises created
}

async function processScriptWithInlineSourceMap (params) {
  const { file, line, sourceMapURL } = params

  // Extract the base64-encoded source map
  const base64SourceMap = sourceMapURL.split('base64,')[1]

  // Decode the base64 source map
  const decodedSourceMap = Buffer.from(base64SourceMap, 'base64').toString('utf8')

  // Parse the source map
  const consumer = await new sourceMap.SourceMapConsumer(decodedSourceMap)

  let generatedPosition

  // Map to the generated position. We'll attempt with the full file path first, then with the basename.
  // TODO: figure out why sometimes the full path doesn't work
  generatedPosition = consumer.generatedPositionFor({
    source: file,
    line,
    column: 0
  })
  if (generatedPosition.line === null) {
    generatedPosition = consumer.generatedPositionFor({
      source: path.basename(file),
      line,
      column: 0
    })
  }

  consumer.destroy()

  // If we can't find the line, just return the original line
  if (generatedPosition.line === null) {
    log.error(`Could not find generated position for ${file}:${line}`)
    return line
  }

  return generatedPosition.line
}
