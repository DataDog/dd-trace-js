'use strict'

const {
  FakeAgent,
  createSandbox
} = require('./helpers')
const childProcess = require('child_process')
const { fork } = childProcess
const path = require('path')
const { assert } = require('chai')
const fs = require('node:fs/promises')
const fsync = require('node:fs')
const zlib = require('node:zlib')
const { Profile } = require('pprof-format')

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

  await processExitPromise(proc, timeout, expectBadExit)
  return resultPromise
}

function processExitPromise (proc, timeout, expectBadExit = false) {
  return new Promise((resolve, reject) => {
    const timeoutObj = setTimeout(() => {
      reject(new Error('Process timed out'))
    }, timeout)

    function checkExitCode (code) {
      clearTimeout(timeoutObj)

      if ((code !== 0) !== expectBadExit) {
        reject(new Error(`Process exited with unexpected status code ${code}.`))
      } else {
        resolve()
      }
    }

    proc
      .on('error', reject)
      .on('exit', checkExitCode)
  })
}

async function getLatestProfile (cwd, pattern) {
  const dirEntries = await fs.readdir(cwd)
  // Get the latest file matching the pattern
  const pprofEntries = dirEntries.filter(name => pattern.test(name))
  assert.isTrue(pprofEntries.length > 0, `No file matching pattern ${pattern} found in ${cwd}`)
  const pprofEntry = pprofEntries
    .map(name => ({ name, modified: fsync.statSync(path.join(cwd, name), { bigint: true }).mtimeNs }))
    .reduce((a, b) => a.modified > b.modified ? a : b)
    .name
  const pprofGzipped = await fs.readFile(path.join(cwd, pprofEntry))
  const pprofUnzipped = zlib.gunzipSync(pprofGzipped)
  return Profile.decode(pprofUnzipped)
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

  it('code hotspots and endpoint tracing works', async () => {
    const procStart = BigInt(Date.now() * 1000000)
    const proc = fork(path.join(cwd, 'profiler/codehotspots.js'), {
      cwd,
      env: {
        DD_PROFILING_PROFILERS: 'wall',
        DD_PROFILING_EXPORTERS: 'file',
        DD_PROFILING_ENABLED: 1,
        DD_PROFILING_CODEHOTSPOTS_ENABLED: 1,
        DD_PROFILING_ENDPOINT_COLLECTION_ENABLED: 1,
        DD_PROFILING_EXPERIMENTAL_TIMELINE_ENABLED: 1
      }
    })

    await processExitPromise(proc, 5000)
    const procEnd = BigInt(Date.now() * 1000000)

    const prof = await getLatestProfile(cwd, /^wall_.+\.pprof$/)

    // We check the profile for following invariants:
    // - every sample needs to have an 'end_timestamp_ns' label that has values (nanos since UNIX
    //   epoch) between process start and end.
    // - it needs to have samples with 9 total different 'span id's, and 3 different
    //   'local root span id's
    // - samples with spans also must have a 'trace endpoint' label with values 'endpoint-0',
    //   'endpoint-1', or 'endpoint-2'
    // - every occurrence of a span must have the same root span and endpoint
    const rootSpans = new Set()
    const endpoints = new Set()
    const spans = new Map()
    const strings = prof.stringTable
    const tsKey = strings.dedup('end_timestamp_ns')
    const spanKey = strings.dedup('span id')
    const rootSpanKey = strings.dedup('local root span id')
    const endpointKey = strings.dedup('trace endpoint')
    const threadNameKey = strings.dedup('thread name')
    const threadNameValue = strings.dedup('Main Event Loop')
    for (const sample of prof.sample) {
      let ts, spanId, rootSpanId, endpoint, threadName
      for (const label of sample.label) {
        switch (label.key) {
          case tsKey: ts = label.num; break
          case spanKey: spanId = label.str; break
          case rootSpanKey: rootSpanId = label.str; break
          case endpointKey: endpoint = label.str; break
          case threadNameKey: threadName = label.str; break
          default: assert.fail(`Unexpected label key ${strings.dedup(label.key)}`)
        }
      }
      // Timestamp must be defined and be between process start and end time
      assert.isDefined(ts)
      assert.isTrue(ts <= procEnd)
      assert.isTrue(ts >= procStart)
      // Thread name must be defined and exactly equal "Main Event Loop"
      assert.equal(threadName, threadNameValue)
      // Either all or none of span-related labels are defined
      if (spanId || rootSpanId || endpoint) {
        assert.isDefined(spanId)
        assert.isDefined(rootSpanId)
        assert.isDefined(endpoint)

        rootSpans.add(rootSpanId)
        const spanData = { rootSpanId, endpoint }
        const existingSpanData = spans.get(spanId)
        if (existingSpanData) {
          // Span's root span and endpoint must be consistent across samples
          assert.deepEqual(spanData, existingSpanData)
        } else {
          // New span id, store span data
          spans.set(spanId, spanData)
          // Verify endpoint value
          const endpointVal = strings.strings[endpoint]
          switch (endpointVal) {
            case 'endpoint-0':
            case 'endpoint-1':
            case 'endpoint-2':
              endpoints.add(endpoint)
              break
            default:
              assert.fail(`Unexpected endpoint value ${endpointVal}`)
          }
        }
      }
    }
    // Need to have a total of 9 different spans, with 3 different root spans
    // and 3 different endpoints.
    assert.equal(spans.size, 9)
    assert.equal(rootSpans.size, 3)
    assert.equal(endpoints.size, 3)
  })

  it('dns timeline events work', async () => {
    const procStart = BigInt(Date.now() * 1000000)
    const proc = fork(path.join(cwd, 'profiler/dnstest.js'), {
      cwd,
      env: {
        DD_PROFILING_PROFILERS: 'wall',
        DD_PROFILING_EXPORTERS: 'file',
        DD_PROFILING_ENABLED: 1,
        DD_PROFILING_EXPERIMENTAL_TIMELINE_ENABLED: 1
      }
    })

    await processExitPromise(proc, 5000)
    const procEnd = BigInt(Date.now() * 1000000)

    const prof = await getLatestProfile(cwd, /^events_.+\.pprof$/)
    assert.isAtLeast(prof.sample.length, 5)

    const strings = prof.stringTable
    const tsKey = strings.dedup('end_timestamp_ns')
    const eventKey = strings.dedup('event')
    const hostKey = strings.dedup('host')
    const addressKey = strings.dedup('address')
    const threadNameKey = strings.dedup('thread name')
    const nameKey = strings.dedup('operation')
    const dnsEventValue = strings.dedup('dns')
    const dnsEvents = []
    for (const sample of prof.sample) {
      let ts, event, host, address, name, threadName
      for (const label of sample.label) {
        switch (label.key) {
          case tsKey: ts = label.num; break
          case nameKey: name = label.str; break
          case eventKey: event = label.str; break
          case hostKey: host = label.str; break
          case addressKey: address = label.str; break
          case threadNameKey: threadName = label.str; break
          default: assert.fail(`Unexpected label key ${label.key} ${strings.strings[label.key]}`)
        }
      }
      // Timestamp must be defined and be between process start and end time
      assert.isDefined(ts)
      assert.isTrue(ts <= procEnd)
      assert.isTrue(ts >= procStart)
      // Gather only DNS events; ignore sporadic GC events
      if (event === dnsEventValue) {
        // Thread name must be defined and exactly equal "Main DNS"
        assert.isTrue(strings.strings[threadName].startsWith('Main DNS-'))
        assert.isDefined(name)
        // Exactly one of these is defined
        assert.isTrue(!!address !== !!host)
        const ev = { name: strings.strings[name] }
        if (address) {
          ev.address = strings.strings[address]
        } else {
          ev.host = strings.strings[host]
        }
        dnsEvents.push(ev)
      }
    }
    assert.sameDeepMembers(dnsEvents, [
      { name: 'lookup', host: 'example.org' },
      { name: 'lookup', host: 'example.com' },
      { name: 'lookup', host: 'datadoghq.com' },
      { name: 'queryA', host: 'datadoghq.com' },
      { name: 'lookupService', address: '13.224.103.60:80' }
    ])
  })

  context('shutdown', () => {
    beforeEach(async () => {
      agent = await new FakeAgent().start()
      oomEnv = {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_PROFILING_ENABLED: 1,
        DD_TRACE_DEBUG: 1,
        DD_TRACE_LOG_LEVEL: 'warn'
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
      proc = fork(oomTestFile, {
        cwd,
        execArgv: oomExecArgv,
        env: oomEnv
      })
      return checkProfiles(agent, proc, timeout, ['space'], true)
    })

    it('sends a heap profile on OOM with external process and exits successfully', async () => {
      proc = fork(oomTestFile, {
        cwd,
        execArgv: oomExecArgv,
        env: {
          ...oomEnv,
          DD_PROFILING_EXPERIMENTAL_OOM_HEAP_LIMIT_EXTENSION_SIZE: 15000000,
          DD_PROFILING_EXPERIMENTAL_OOM_MAX_HEAP_EXTENSION_COUNT: 3
        }
      })
      return checkProfiles(agent, proc, timeout, ['space'], false, 2)
    })

    it('sends a heap profile on OOM with async callback', async () => {
      proc = fork(oomTestFile, {
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

    it('sends heap profiles on OOM with multiple strategies', async () => {
      proc = fork(oomTestFile, {
        cwd,
        execArgv: oomExecArgv,
        env: {
          ...oomEnv,
          DD_PROFILING_EXPERIMENTAL_OOM_HEAP_LIMIT_EXTENSION_SIZE: 10000000,
          DD_PROFILING_EXPERIMENTAL_OOM_MAX_HEAP_EXTENSION_COUNT: 1,
          DD_PROFILING_EXPERIMENTAL_OOM_EXPORT_STRATEGIES: 'async,process'
        }
      })
      return checkProfiles(agent, proc, timeout, ['space'], true, 2)
    })

    it('sends a heap profile on OOM in worker thread and exits successfully', async () => {
      proc = fork(oomTestFile, [1, 50], {
        cwd,
        env: { ...oomEnv, DD_PROFILING_WALLTIME_ENABLED: 0 }
      })
      return checkProfiles(agent, proc, timeout, ['space'], false, 2)
    })
  })
})
