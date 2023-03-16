'use strict'

const {
  FakeAgent,
  createSandbox
} = require('./helpers')
const childProcess = require('child_process')
const { fork } = childProcess
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

    function CheckExitCode (code) {
      clearTimeout(timeoutObj)
      if ((code !== 0) !== expectBadExit) {
        reject(new Error(`Process exited with unexepected status code ${code}.`))
      } else {
        resolve()
      }
    }

    proc
      .on('error', reject)
      .on('exit', CheckExitCode)
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
  let oomEnv
  let oomExecArgv
  const timeout = 5000

  before(async () => {
    sandbox = await createSandbox()
    cwd = sandbox.folder
    profilerTestFile = path.join(cwd, 'profiler/index.js')
    oomTestFile = path.join(cwd, 'profiler/oom.js')
    oomExecArgv = ['--max-old-space-size=50']
  })

  after(async () => {
    await sandbox.remove()
  })

  context('shutdown', () => {
    beforeEach(async () => {
      agent = await new FakeAgent().start()
      oomEnv = {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_PROFILING_ENABLED: 1,
        DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED: 1,
        DD_PROFILING_EXPERIMENTAL_OOM_EXPORT_STRATEGIES: 'process'
      }
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('records profile on process exit', async () => {
      proc = fork(profilerTestFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_PROFILING_ENABLED: 1
        }
      })
      return checkProfiles(agent, proc, timeout)
    })

    it('sends a heap profile on OOM with external process', async () => {
      proc = await fork(oomTestFile, {
        cwd,
        execArgv: oomExecArgv,
        env: oomEnv
      })
      return checkProfiles(agent, proc, timeout, ['space'], true)
    })

    it('sends a heap profile on OOM with external process and ends successfully', async () => {
      proc = await fork(oomTestFile, {
        cwd,
        execArgv: oomExecArgv,
        env: {
          ...oomEnv,
          DD_PROFILING_EXPERIMENTAL_OOM_HEAP_LIMIT_EXTENSION_SIZE: 15000000,
          DD_PROFILING_EXPERIMENTAL_OOM_MAX_HEAP_EXTENSION_COUNT: 2
        }
      })
      return checkProfiles(agent, proc, timeout, ['space'], false, 2)
    })

    it('sends a heap profile on OOM with async callback', async () => {
      proc = await fork(oomTestFile, {
        cwd,
        execArgv: oomExecArgv,
        env: {
          ...oomEnv,
          DD_PROFILING_EXPERIMENTAL_OOM_HEAP_LIMIT_EXTENSION_SIZE: 10000000,
          DD_PROFILING_EXPERIMENTAL_OOM_MAX_HEAP_EXTENSION_COUNT: 1,
          DD_PROFILING_EXPERIMENTAL_OOM_EXPORT_STRATEGIES: 'async'
        }
      })
      return checkProfiles(agent, proc, timeout, ['space'], true)
    })

    it('sends a heap profile on OOM with interrupt callback', async () => {
      proc = await fork(oomTestFile, {
        cwd,
        execArgv: oomExecArgv,
        env: {
          ...oomEnv,
          DD_PROFILING_EXPERIMENTAL_OOM_HEAP_LIMIT_EXTENSION_SIZE: 10000000,
          DD_PROFILING_EXPERIMENTAL_OOM_MAX_HEAP_EXTENSION_COUNT: 1,
          DD_PROFILING_EXPERIMENTAL_OOM_EXPORT_STRATEGIES: 'interrupt'
        }
      })
      return checkProfiles(agent, proc, timeout, ['space'], true)
    })

    it('sends heap profiles on OOM with multiple strategies', async () => {
      proc = await fork(oomTestFile, {
        cwd,
        execArgv: oomExecArgv,
        env: {
          ...oomEnv,
          DD_PROFILING_EXPERIMENTAL_OOM_HEAP_LIMIT_EXTENSION_SIZE: 10000000,
          DD_PROFILING_EXPERIMENTAL_OOM_MAX_HEAP_EXTENSION_COUNT: 1,
          DD_PROFILING_EXPERIMENTAL_OOM_EXPORT_STRATEGIES: 'async,interrupt,process'
        }
      })
      return checkProfiles(agent, proc, timeout, ['space'], true, 4)
    })
  })
})
