'use strict'

const {
  FakeAgent,
  spawnProc,
  createSandbox
} = require('./helpers')
const path = require('path')
const { assert } = require('chai')

async function checkProfiles (agent, proc, timeout,
  expectedProfileTypes = ['wall', 'space'], expectBadExit = false, multiplicity = 1) {
  const resultPromise = agent.assertMessageReceived(({ headers, payload, files }) => {
    assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
    assert.propertyVal(payload, 'format', 'pprof')
    assert.deepPropertyVal(payload, 'types', expectedProfileTypes)
    for (const [index, profileType] of expectedProfileTypes.entries()) {
      assert.propertyVal(files[index], 'originalname', `${profileType}.pb.gz`)
    }
  }, timeout, multiplicity)

  await new Promise((resolve, reject) => {
    const timeoutObj = setTimeout(() => {
      reject(new Error('Process timed out'))
    }, timeout)

    proc.on('exit', code => {
      clearTimeout(timeoutObj)
      if ((code !== 0) !== expectBadExit) {
        reject(new Error(`Process exited with unexepected status code ${code}.`))
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
  let oomTestFile

  before(async () => {
    sandbox = await createSandbox()
    cwd = sandbox.folder
    profilerTestFile = path.join(cwd, 'profiler/index.js')
    oomTestFile = path.join(cwd, 'profiler/oom.js')
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

    it('sends a heap profile on OOM with external process', async () => {
      proc = await spawnProc(oomTestFile, {
        cwd,
        execArgv: ['--max-old-space-size=50'],
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_PROFILING_ENABLED: 1,
          DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED: 1,
          DD_PROFILING_EXPERIMENTAL_OOM_EXPORT_STRATEGIES: 'process'
        }
      })
      return checkProfiles(agent, proc, 5000, ['space'], true)
    })

    it('sends a heap profile on OOM with external process and ends successfully', async () => {
      proc = await spawnProc(oomTestFile, {
        cwd,
        execArgv: ['--max-old-space-size=50'],
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_PROFILING_ENABLED: 1,
          DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED: 1,
          DD_PROFILING_EXPERIMENTAL_OOM_HEAP_LIMIT_EXTENSION_SIZE: 15000000,
          DD_PROFILING_EXPERIMENTAL_OOM_MAX_HEAP_EXTENSION_COUNT: 2,
          DD_PROFILING_EXPERIMENTAL_OOM_EXPORT_STRATEGIES: 'process'
        }
      })
      return checkProfiles(agent, proc, 5000, ['space'], false, 2)
    })

    it('sends a heap profile on OOM with async callback', async () => {
      proc = await spawnProc(oomTestFile, {
        cwd,
        execArgv: ['--max-old-space-size=50'],
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_PROFILING_ENABLED: 1,
          DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED: 1,
          DD_PROFILING_EXPERIMENTAL_OOM_HEAP_LIMIT_EXTENSION_SIZE: 10000000,
          DD_PROFILING_EXPERIMENTAL_OOM_MAX_HEAP_EXTENSION_COUNT: 1,
          DD_PROFILING_EXPERIMENTAL_OOM_EXPORT_STRATEGIES: 'async'
        }
      })
      return checkProfiles(agent, proc, 5000, ['space'], true)
    })

    it('sends a heap profile on OOM with interrupt callback', async () => {
      proc = await spawnProc(oomTestFile, {
        cwd,
        execArgv: ['--max-old-space-size=50'],
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_PROFILING_ENABLED: 1,
          DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED: 1,
          DD_PROFILING_EXPERIMENTAL_OOM_HEAP_LIMIT_EXTENSION_SIZE: 10000000,
          DD_PROFILING_EXPERIMENTAL_OOM_MAX_HEAP_EXTENSION_COUNT: 1,
          DD_PROFILING_EXPERIMENTAL_OOM_EXPORT_STRATEGIES: 'interrupt'
        }
      })
      return checkProfiles(agent, proc, 5000, ['space'], true)
    })

    it('sends heap profiles on OOM with multiple strategies', async () => {
      proc = await spawnProc(oomTestFile, {
        cwd,
        execArgv: ['--max-old-space-size=50'],
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_PROFILING_ENABLED: 1,
          DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED: 1,
          DD_PROFILING_EXPERIMENTAL_OOM_HEAP_LIMIT_EXTENSION_SIZE: 10000000,
          DD_PROFILING_EXPERIMENTAL_OOM_MAX_HEAP_EXTENSION_COUNT: 1,
          DD_PROFILING_EXPERIMENTAL_OOM_EXPORT_STRATEGIES: 'async,interrupt,process'
        }
      })
      return checkProfiles(agent, proc, 5000, ['space'], true, 4)
    })
  })
})
