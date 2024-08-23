'use strict'

const spawn = require('cross-spawn')
const waitOn = require('wait-on')

const agent = require('../../dd-trace/test/plugins/agent')
const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

describe('azure-functions testsing', () => {
  withVersions('azure-functions', ['@azure/functions'], (version, moduleName) => {
    let child

    before(async () => {
      const clear = await freePort()
      clear.stderr.on('data', (data) => {
        console.error(`stderr-: ${data}`)
      })

      clear.on('close', (code) => {
        console.log(`lsof process exited with code ${code}`)
      })
      return agent.load('azure-functions')
    })

    after(() => {
      return agent.close({ ritmReset: false })
    })
    beforeEach(async () => {
      child = await start(agent.server.address().port)
      child.stderr.on('data', (data) => {
        console.error(`stderr-: ${data}`)
      })

      child.on('close', (code) => {
        console.log(`lsof process exited with code ${code}`)
      })
    })

    afterEach(() => {
      stopProcess(child)
    })

    it('span generation', async () => {
      const checkTraces = agent.use(traces => {
        const span = sort(traces[0])[0]
        expect(span).to.include({
          name: 'azure-function',
          resource: 'MyHttpTrigger',
          service: 'test'
        })
        expect(span.meta).to.include({
          component: 'azure-functions'
        })
      })
      await fetch('http://127.0.0.1:7071/api/MyHttpTrigger')
      await checkTraces
    })
  })
})

async function freePort () {
  const port = await spawn("pid=$(lsof -i tcp:7071 | awk 'NR==2 {print $2}') && [ -n '$pid' ] && kill -9 ${pid}", {
    shell: true
  })
  await waitOn({
    resources: [
      'tcp:localhost:7071'
    ],
    reverse: true,
    timeout: 3000,
    log: true
  })
  return port
}

async function start (port) {
  const child = spawn('cd packages/datadog-plugin-azure-functions/test && func start', {
    shell: true,
    env: {
      ...process.env,
      DD_TRACE_AGENT_PORT: port
    }
  })
  await waitOn({
    resources: [
      'tcp:localhost:7071'
    ],
    timeout: 3000,
    log: true
  })
  return child
}

async function stopProcess (child) {
  await killAndWait(child)
}
async function killAndWait (proc) {
  const k = require('tree-kill')
  k(proc.pid, 'SIGKILL')
  while (isRunning(proc.pid)) {
    await setTimeoutPromise(1000)
  }
}

async function setTimeoutPromise (ms) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      resolve()
    }, ms)
  })
}

function isRunning (pid) {
  if (!pid) {
    return false
  }

  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}
