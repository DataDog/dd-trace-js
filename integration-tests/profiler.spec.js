'use strict'

const {
  FakeAgent,
  spawnProc,
  createSandbox
} = require('./helpers')
const path = require('path')
const { assert } = require('chai')

async function checkProfiles (agent, proc, timeout) {
  const resultPromise = agent.assertMessageReceived(({ headers, payload, files }) => {
    assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
    assert.propertyVal(payload, 'format', 'pprof')
    assert.deepPropertyVal(payload, 'types', ['wall', 'space'])
    assert.propertyVal(files[0], 'originalname', 'wall.pb.gz')
    assert.propertyVal(files[1], 'originalname', 'space.pb.gz')
  }, timeout)

  await new Promise((resolve, reject) => {
    const timeoutObj = setTimeout(() => {
      reject(new Error('Process timed out'))
    }, timeout)

    proc.on('exit', code => {
      clearTimeout(timeoutObj)
      if (code !== 0) {
        reject(new Error(`Process exited with status code ${code}.`))
      } else {
        resolve()
      }
    })
  })

  return resultPromise
}

describe('profiler', () => {
  let agent
  let proc
  let sandbox
  let cwd
  let profilerTestFile

  before(async () => {
    sandbox = await createSandbox()
    cwd = sandbox.folder
    profilerTestFile = path.join(cwd, 'profiler/index.js')
  })

  after(async () => {
    await sandbox.remove()
  })

  context('shutdown', () => {
    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('records profile on process exit', async () => {
      proc = await spawnProc(profilerTestFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_PROFILING_ENABLED: 1
        }
      })
      return checkProfiles(agent, proc, 5000)
    })
  })
})
