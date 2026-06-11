'use strict'

const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const path = require('node:path')

const satisfies = require('semifies')

const { Profile } = require('../../vendor/dist/pprof-format')
const {
  FakeAgent,
  sandboxCwd,
  stopProc,
  useSandbox,
} = require('../helpers')
const { processExitPromise } = require('./helpers')

const TIMEOUT = 30000
const isAtLeast26 = satisfies(process.versions.node, '>=26.0.0')

function getString (strings, value) {
  const index = typeof value?.toNumber === 'function' ? value.toNumber() : Number(value)
  return strings[index]
}

function getSampleTypeNames (profile) {
  const strings = profile.stringTable.strings
  return profile.sampleType.map(sampleType => getString(strings, sampleType.type))
}

function findFile (files, originalname) {
  const file = files.find(file => file.originalname === originalname)
  assert.ok(file, `Expected ${originalname} attachment`)
  return file
}

function startProfiler ({ cwd, allocationProfilingEnabled, agent }) {
  const env = {
    DD_PROFILING_DEBUG_UPLOAD_COMPRESSION: 'off',
    DD_PROFILING_ENABLED: '1',
    DD_PROFILING_ALLOCATION_ENABLED: allocationProfilingEnabled ? 'true' : 'false',
    DD_PROFILING_EXPORTERS: agent ? 'agent' : 'file',
    DD_PROFILING_PROFILERS: 'space',
    DD_PROFILING_SOURCE_MAP: '0',
    DD_PROFILING_UPLOAD_PERIOD: '1',
    TEST_DURATION_MS: '5000',
  }

  if (agent) {
    env.DD_TRACE_AGENT_PORT = agent.port
  }

  return fork(path.join(cwd, 'profiler/index.js'), { cwd, env })
}

async function runProfiler ({ cwd, allocationProfilingEnabled }) {
  const proc = startProfiler({ cwd, allocationProfilingEnabled })

  try {
    await processExitPromise(proc, TIMEOUT)
  } finally {
    await stopProc(proc)
  }
}

async function runProfilerAndGetUpload ({ cwd, allocationProfilingEnabled }) {
  const agent = await new FakeAgent().start()
  let upload

  const messagePromise = agent.assertMessageReceived(({ files }) => {
    assert.ok(files, 'Expected profiling upload')

    upload = {
      event: JSON.parse(findFile(files, 'event.json').buffer.toString()),
      spaceProfile: Profile.decode(findFile(files, 'space.pprof').buffer),
    }
  }, TIMEOUT)

  const proc = startProfiler({ cwd, allocationProfilingEnabled, agent })

  try {
    await Promise.all([
      messagePromise,
      processExitPromise(proc, TIMEOUT),
    ])
    return upload
  } finally {
    await stopProc(proc)
    await agent.stop()
  }
}

describe('allocation profiler', () => {
  let cwd

  useSandbox()

  before(() => {
    cwd = sandboxCwd()
  })

  it('sends heap profiles with the expected sample types on Node.js 26+', async function () {
    if (!isAtLeast26) {
      this.skip()
      return
    }

    const cases = [
      {
        allocationProfilingEnabled: false,
        sampleTypes: ['objects', 'space'],
      },
      {
        allocationProfilingEnabled: true,
        sampleTypes: ['inuse_objects', 'alloc_objects', 'inuse_space', 'alloc_space'],
      },
    ]

    for (const { allocationProfilingEnabled, sampleTypes } of cases) {
      const { event, spaceProfile } = await runProfilerAndGetUpload({ cwd, allocationProfilingEnabled })

      assert.deepStrictEqual(event.attachments, ['space.pprof'])
      assert.strictEqual(event.info.profiler.settings.allocationProfilingEnabled, allocationProfilingEnabled)
      assert.deepStrictEqual(getSampleTypeNames(spaceProfile), sampleTypes)
    }
  })

  it('does not crash when allocation profiling is requested on unsupported Node.js versions', async function () {
    if (isAtLeast26) {
      this.skip()
      return
    }

    await runProfiler({
      cwd,
      allocationProfilingEnabled: true,
    })
  })
})
