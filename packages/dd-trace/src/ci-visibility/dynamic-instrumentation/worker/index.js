'use strict'
const sourceMap = require('source-map')
const path = require('path')
const { workerData: { breakpointSetChannel, breakpointHitChannel } } = require('worker_threads')

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

const breakpointIdToSnapshotId = new Map()
const breakpointIdToProbe = new Map()

session.on('Debugger.paused', async ({ params: { hitBreakpoints: [hitBreakpoint], callFrames } }) => {
  const probe = breakpointIdToProbe.get(hitBreakpoint)
  if (!probe) {
    log.warn(`No probe found for breakpoint ${hitBreakpoint}`)
    return session.post('Debugger.resume')
  }

  const stack = getStackFromCallFrames(callFrames)

  const getLocalState = await getLocalStateForCallFrame(callFrames[0])

  await session.post('Debugger.resume')

  const snapshotId = breakpointIdToSnapshotId.get(hitBreakpoint)

  const snapshot = {
    id: snapshotId,
    timestamp: Date.now(),
    probe: {
      id: probe.probeId,
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

// TODO: add option to remove breakpoint
breakpointSetChannel.on('message', async ({ snapshotId, probe: { id: probeId, file, line } }) => {
  await addBreakpoint(snapshotId, { probeId, file, line })
  breakpointSetChannel.postMessage({ probeId })
})

async function addBreakpoint (snapshotId, probe) {
  if (!sessionStarted) await start()
  const { file, line } = probe

  probe.location = { file, lines: [String(line)] }

  const script = findScriptFromPartialPath(file)
  if (!script) throw new Error(`No loaded script found for ${file}`)

  const [path, scriptId, sourceMapURL] = script

  log.debug(`Adding breakpoint at ${path}:${line}`)

  let lineNumber = line

  if (sourceMapURL && sourceMapURL.startsWith('data:')) {
    try {
      lineNumber = await processScriptWithInlineSourceMap({ file, line, sourceMapURL })
    } catch (err) {
      log.error(err)
    }
  }

  const { breakpointId } = await session.post('Debugger.setBreakpoint', {
    location: {
      scriptId,
      lineNumber: lineNumber - 1
    }
  })

  breakpointIdToProbe.set(breakpointId, probe)
  breakpointIdToSnapshotId.set(breakpointId, snapshotId)
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

  // Map to the generated position
  const generatedPosition = consumer.generatedPositionFor({
    source: path.basename(file), // this needs to be the file, not the filepath
    line,
    column: 0
  })

  consumer.destroy()

  return generatedPosition.line
}
