const path = require('path')
const { parentPort } = require('worker_threads')

const {
  getStackFromCallFrames,
  findScriptFromPartialPath
} = require('../../../../src/debugger/devtools_client/state')
const { getLocalStateForCallFrame } = require('../../../../src/debugger/devtools_client/snapshot')

const session = require('../../../../src/debugger/devtools_client/session')

const filename = path.join(__dirname, 'di-dependency.js')

parentPort.on('message', (message) => {
  console.log('message received', message)
})

async function run () {
  await session.post('Debugger.enable')

  console.log('enabled')

  const [, scriptId] = findScriptFromPartialPath(filename)

  console.log('scriptId', scriptId)

  await session.post('Debugger.setBreakpoint', {
    location: {
      scriptId,
      lineNumber: 6
    }
  })

  console.log('breakpoint set', filename)
}

session.on('Debugger.paused', async ({ params: { callFrames }}) => {
  // console.log('debugger passed!', callFrames)

  const stack = getStackFromCallFrames(callFrames)

  const getLocalState = await getLocalStateForCallFrame(callFrames[0])

  await session.post('Debugger.resume')

  console.log('debugger resumed')

  const state = getLocalState()

  console.log('state', state)
  // console.log('stack', stack)
})

run()
