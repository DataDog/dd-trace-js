const { parentPort } = require('worker_threads')
// TODO: maybe move session to common place
const session = require('../../../debugger/devtools_client/session')
// TODO: maybe move getLocalStateForCallFrame to common place
const { getLocalStateForCallFrame } = require('../../../debugger/devtools_client/snapshot')

let sessionStarted = false
const scriptIds = []
const scriptUrls = new Map()
const probes = new Map()
const breakpoints = new Map()

function findScriptFromPartialPath (path) {
  return scriptIds
    .filter(([url]) => url.endsWith(path))
    .sort(([a], [b]) => a.length - b.length)[0]
}

session.on('Debugger.scriptParsed', ({ params }) => {
  scriptUrls.set(params.scriptId, params.url)
  if (params.url.startsWith('file:')) {
    scriptIds.push([params.url, params.scriptId])
  }
})

session.on('Debugger.paused', async ({ params }) => {
  const probe = breakpoints.get(params.hitBreakpoints[0])

  // so the parent knows what probe it's getting a response from
  const probeId = probes.get(params.hitBreakpoints[0])

  const getLocalState = await getLocalStateForCallFrame(params.callFrames[0])
  await session.post('Debugger.resume')

  const state = getLocalState()

  parentPort.postMessage({ probe, state, id: probeId })
})

// TODO: add option to remove breakpoint
// message handling
parentPort.on('message', async ({ probe: { id: probeId, file, line } }) => {
  // only message at the moment is a line probe
  await addBreakpoint({ probeId, file, line })
})

async function addBreakpoint (probe) {
  if (!sessionStarted) await start()
  const { file, line, probeId } = probe

  const script = findScriptFromPartialPath(file)
  if (!script) throw new Error(`No loaded script found for ${file}`)

  const [path, scriptId] = script

  console.log(`Adding breakpoint at ${path}:${line}`)

  const { breakpointId } = await session.post('Debugger.setBreakpoint', {
    location: {
      scriptId,
      lineNumber: line - 1 // Beware! lineNumber is zero-indexed
    }
  })

  probes.set(breakpointId, probeId)

  breakpoints.set(breakpointId, probe)
}

function start () {
  sessionStarted = true
  return session.post('Debugger.enable') // return instead of await to reduce number of promises created
}
