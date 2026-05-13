'use strict'

const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const fs = require('node:fs/promises')
const fsync = require('node:fs')
const path = require('node:path')

const satisfies = require('semifies')

const { Profile } = require('../../vendor/dist/pprof-format')
const {
  sandboxCwd,
  stopProc,
  useSandbox,
} = require('../helpers')

const TIMEOUT = 30000
const isAtLeast26 = satisfies(process.versions.node, '>=26.0.0')

function processExitPromise (proc, timeout) {
  return new Promise((resolve, reject) => {
    const timeoutObj = setTimeout(() => {
      reject(new Error('Process timed out'))
    }, timeout)

    proc
      .on('error', reject)
      .on('exit', code => {
        clearTimeout(timeoutObj)

        if (code !== 0) {
          reject(new Error(`Process exited with unexpected status code ${code}.`))
        } else {
          resolve()
        }
      })
  })
}

function getString (strings, value) {
  const index = typeof value?.toNumber === 'function' ? value.toNumber() : Number(value)
  return strings[index]
}

function getSampleTypeNames (profile) {
  const strings = profile.stringTable.strings
  return profile.sampleType.map(sampleType => getString(strings, sampleType.type))
}

async function readLatestFile (cwd, pattern) {
  const dirEntries = await fs.readdir(cwd)
  const entries = dirEntries.filter(name => pattern.test(name))
  assert.ok(entries.length > 0, `No file matching pattern ${pattern} found in ${cwd}`)

  const entry = entries
    .map(name => ({ name, modified: fsync.statSync(path.join(cwd, name), { bigint: true }).mtimeNs }))
    .reduce((a, b) => a.modified > b.modified ? a : b)
    .name

  return fs.readFile(path.join(cwd, entry))
}

async function runProfiler ({ cwd, allocationProfilingEnabled, pprofPrefix = '' }) {
  const proc = fork(path.join(cwd, 'profiler/index.js'), {
    cwd,
    env: {
      DD_PROFILING_DEBUG_UPLOAD_COMPRESSION: 'off',
      DD_PROFILING_ENABLED: '1',
      DD_PROFILING_EXPERIMENTAL_ALLOCATION_ENABLED: allocationProfilingEnabled ? '1' : '0',
      DD_PROFILING_EXPORTERS: 'file',
      DD_PROFILING_PPROF_PREFIX: pprofPrefix,
      DD_PROFILING_PROFILERS: 'space',
      DD_PROFILING_SOURCE_MAP: '0',
      DD_PROFILING_UPLOAD_PERIOD: '1',
      DD_TRACE_ENABLED: '0',
      TEST_DURATION_MS: '2500',
    },
  })

  try {
    await processExitPromise(proc, TIMEOUT)
  } finally {
    await stopProc(proc)
  }
}

async function getLatestProfilerOutput (cwd, pprofPrefix) {
  const event = JSON.parse((await readLatestFile(cwd, /^event_.+\.json$/)).toString())
  const spaceProfile = Profile.decode(await readLatestFile(cwd, new RegExp(`^${pprofPrefix}space_.+\\.pprof$`)))

  return { event, spaceProfile }
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
        pprofPrefix: 'heap_',
        sampleTypes: ['objects', 'space'],
      },
      {
        allocationProfilingEnabled: true,
        pprofPrefix: 'allocation_',
        sampleTypes: ['inuse_objects', 'alloc_objects', 'inuse_space', 'alloc_space'],
      },
    ]

    for (const { allocationProfilingEnabled, pprofPrefix, sampleTypes } of cases) {
      await runProfiler({ cwd, allocationProfilingEnabled, pprofPrefix })
      const { event, spaceProfile } = await getLatestProfilerOutput(cwd, pprofPrefix)

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
