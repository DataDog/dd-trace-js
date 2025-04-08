'use strict'

const {
  FakeAgent,
  createSandbox
} = require('../helpers')
const childProcess = require('child_process')
const { fork } = childProcess
const path = require('path')
const { assert } = require('chai')
const fs = require('fs/promises')
const fsync = require('fs')
const net = require('net')
const zlib = require('zlib')
const { Profile } = require('pprof-format')

const DEFAULT_PROFILE_TYPES = ['wall', 'space']
if (process.platform !== 'win32') {
  DEFAULT_PROFILE_TYPES.push('events')
}

function checkProfiles (agent, proc, timeout,
  expectedProfileTypes = DEFAULT_PROFILE_TYPES, expectBadExit = false, multiplicity = 1
) {
  return Promise.all([
    processExitPromise(proc, timeout, expectBadExit),
    expectProfileMessagePromise(agent, timeout, expectedProfileTypes, multiplicity)
  ])
}

function expectProfileMessagePromise (agent, timeout,
  expectedProfileTypes = DEFAULT_PROFILE_TYPES, multiplicity = 1
) {
  const fileNames = expectedProfileTypes.map(type => `${type}.pprof`)
  return agent.assertMessageReceived(({ headers, _, files }) => {
    let event
    try {
      assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
      assert.propertyVal(files[0], 'originalname', 'event.json')
      event = JSON.parse(files[0].buffer.toString())
      assert.propertyVal(event, 'family', 'node')
      assert.isString(event.info.profiler.activation)
      assert.isString(event.info.profiler.ssi.mechanism)
      assert.deepPropertyVal(event, 'attachments', fileNames)
      for (const [index, fileName] of fileNames.entries()) {
        assert.propertyVal(files[index + 1], 'originalname', fileName)
      }
    } catch (e) {
      e.message += ` ${JSON.stringify({ headers, files, event })}`
      throw e
    }
  }, timeout, multiplicity)
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
  const pprofGzipped = await readLatestFile(cwd, pattern)
  const pprofUnzipped = zlib.gunzipSync(pprofGzipped)
  return { profile: Profile.decode(pprofUnzipped), encoded: pprofGzipped.toString('base64') }
}

async function readLatestFile (cwd, pattern) {
  const dirEntries = await fs.readdir(cwd)
  // Get the latest file matching the pattern
  const pprofEntries = dirEntries.filter(name => pattern.test(name))
  assert.isTrue(pprofEntries.length > 0, `No file matching pattern ${pattern} found in ${cwd}`)
  const pprofEntry = pprofEntries
    .map(name => ({ name, modified: fsync.statSync(path.join(cwd, name), { bigint: true }).mtimeNs }))
    .reduce((a, b) => a.modified > b.modified ? a : b)
    .name
  return await fs.readFile(path.join(cwd, pprofEntry))
}

function expectTimeout (messagePromise, allowErrors = false) {
  return messagePromise.then(
    () => {
      throw new Error('Received unexpected message')
    }, (e) => {
      if (e.message !== 'timeout' && (!allowErrors || !e.message.startsWith('timeout, additionally:'))) {
        throw e
      }
    }
  )
}

class TimelineEventProcessor {
  constructor (strings, encoded) {
    this.strings = strings
    this.encoded = encoded
  }
}

class NetworkEventProcessor extends TimelineEventProcessor {
  constructor (strings, encoded) {
    super(strings, encoded)

    this.hostKey = strings.dedup('host')
    this.addressKey = strings.dedup('address')
    this.portKey = strings.dedup('port')
  }

  processLabel (label, processedLabels) {
    switch (label.key) {
      case this.hostKey:
        processedLabels.host = label.str
        return true
      case this.addressKey:
        processedLabels.address = label.str
        return true
      case this.portKey:
        processedLabels.port = label.num
        return true
      default:
        return false
    }
  }

  decorateEvent (ev, pl) {
    // Exactly one of these is defined
    assert.isTrue(!!pl.address !== !!pl.host, this.encoded)
    if (pl.address) {
      ev.address = this.strings.strings[pl.address]
    } else {
      ev.host = this.strings.strings[pl.host]
    }
    if (pl.port) {
      ev.port = pl.port
    }
  }
}

async function gatherNetworkTimelineEvents (cwd, scriptFilePath, eventType, args) {
  return gatherTimelineEvents(cwd, scriptFilePath, eventType, args, NetworkEventProcessor)
}

class FilesystemEventProcessor extends TimelineEventProcessor {
  constructor (strings, encoded) {
    super(strings, encoded)

    this.fdKey = strings.dedup('fd')
    this.fileKey = strings.dedup('file')
    this.flagKey = strings.dedup('flag')
    this.modeKey = strings.dedup('mode')
    this.pathKey = strings.dedup('path')
  }

  processLabel (label, processedLabels) {
    switch (label.key) {
      case this.fdKey:
        processedLabels.fd = label.num
        return true
      case this.fileKey:
        processedLabels.file = label.str
        return true
      case this.flagKey:
        processedLabels.flag = label.str
        return true
      case this.modeKey:
        processedLabels.mode = label.str
        return true
      case this.pathKey:
        processedLabels.path = label.str
        return true
      default:
        return false
    }
  }

  decorateEvent (ev, pl) {
    ev.fd = pl.fd
    ev.file = this.strings.strings[pl.file]
    ev.flag = this.strings.strings[pl.flag]
    ev.mode = this.strings.strings[pl.mode]
    ev.path = this.strings.strings[pl.path]
    for (const [k, v] of Object.entries(ev)) {
      if (v === undefined) {
        delete ev[k]
      }
    }
  }
}

async function gatherFilesystemTimelineEvents (cwd, scriptFilePath) {
  return gatherTimelineEvents(cwd, scriptFilePath, 'fs', [], FilesystemEventProcessor)
}

async function gatherTimelineEvents (cwd, scriptFilePath, eventType, args, Processor) {
  const procStart = BigInt(Date.now() * 1000000)
  const proc = fork(path.join(cwd, scriptFilePath), args, {
    cwd,
    env: {
      DD_PROFILING_EXPORTERS: 'file',
      DD_PROFILING_ENABLED: 1,
      DD_INTERNAL_PROFILING_TIMELINE_SAMPLING_ENABLED: 0 // capture all events
    }
  })

  await processExitPromise(proc, 30000)
  const procEnd = BigInt(Date.now() * 1000000)

  const { profile, encoded } = await getLatestProfile(cwd, /^events_.+\.pprof$/)

  const strings = profile.stringTable
  const tsKey = strings.dedup('end_timestamp_ns')
  const eventKey = strings.dedup('event')
  const operationKey = strings.dedup('operation')
  const spanIdKey = strings.dedup('span id')
  const localRootSpanIdKey = strings.dedup('local root span id')
  const eventValue = strings.dedup(eventType)
  const events = []
  const processor = new Processor(strings, encoded)
  for (const sample of profile.sample) {
    let ts, event, operation, spanId, localRootSpanId
    const processedLabels = {}
    const unexpectedLabels = []
    for (const label of sample.label) {
      switch (label.key) {
        case tsKey: ts = label.num; break
        case operationKey: operation = label.str; break
        case eventKey: event = label.str; break
        case spanIdKey: spanId = label.str; break
        case localRootSpanIdKey: localRootSpanId = label.str; break
        default:
          if (!processor.processLabel(label, processedLabels)) {
            unexpectedLabels.push(label.key)
          }
      }
    }
    // Timestamp must be defined and be between process start and end time
    assert.isDefined(ts, encoded)
    assert.isTrue(ts <= procEnd, encoded)
    assert.isTrue(ts >= procStart, encoded)
    // Gather only tested events
    if (event === eventValue) {
      if (process.platform !== 'win32') {
        assert.isDefined(spanId, encoded)
        assert.isDefined(localRootSpanId, encoded)
      } else {
        assert.isUndefined(spanId, encoded)
        assert.isUndefined(localRootSpanId, encoded)
      }
      assert.isDefined(operation, encoded)
      if (unexpectedLabels.length > 0) {
        const labelsStr = JSON.stringify(unexpectedLabels)
        const labelsStrStr = unexpectedLabels.map(k => strings.strings[k]).join(',')
        assert.fail(`Unexpected labels: ${labelsStr}\n${labelsStrStr}\n${encoded}`)
      }
      const ev = { operation: strings.strings[operation] }
      processor.decorateEvent(ev, processedLabels)
      events.push(ev)
    }
  }
  return events
}

describe('profiler', () => {
  let agent
  let proc
  let sandbox
  let cwd
  let profilerTestFile
  let ssiTestFile
  let oomTestFile
  let oomEnv
  let oomExecArgv
  const timeout = 30000

  before(async () => {
    sandbox = await createSandbox()
    cwd = sandbox.folder
    profilerTestFile = path.join(cwd, 'profiler/index.js')
    ssiTestFile = path.join(cwd, 'profiler/ssi.js')
    oomTestFile = path.join(cwd, 'profiler/oom.js')
    oomExecArgv = ['--max-old-space-size=50']
  })

  after(async () => {
    await sandbox.remove()
  })

  if (process.platform !== 'win32') {
    it('code hotspots and endpoint tracing works', async function () {
      this.retries(9) // see fail-fast comment below
      const procStart = BigInt(Date.now() * 1000000)
      const proc = fork(path.join(cwd, 'profiler/codehotspots.js'), {
        cwd,
        env: {
          DD_PROFILING_EXPORTERS: 'file',
          DD_PROFILING_ENABLED: 1
        }
      })

      await processExitPromise(proc, 30000)
      const procEnd = BigInt(Date.now() * 1000000)

      // Must've counted the number of times each endpoint was hit
      const event = JSON.parse((await readLatestFile(cwd, /^event_.+\.json$/)).toString())
      assert.deepEqual(event.endpoint_counts, { 'endpoint-0': 1, 'endpoint-1': 1, 'endpoint-2': 1 })

      const { profile, encoded } = await getLatestProfile(cwd, /^wall_.+\.pprof$/)

      // Fail fast (and retry) if we gathered a small number of samples. This can happen if the
      // machine is CPU-constrained. We run 9 spans each for 100ms, sampled at 99Hz, so we should
      // ideally have 89 samples. We'll settle for 60% of that.
      assert.isAtLeast(profile.sample.length, 53, encoded)

      this.retries(0) // stop retrying, as with 53+ samples the rest of the test should pass

      // We check the profile for following invariants:
      // - every sample needs to have an 'end_timestamp_ns' label that has values (nanos since UNIX
      //   epoch) between process start and end.
      // - it needs to have samples with 9 total different 'span id's, and 3 different
      //   'local root span id's
      // - samples with spans also must have a 'trace endpoint' label with values 'endpoint-0',
      //   'endpoint-1', or 'endpoint-2'
      // - every occurrence of a span must have the same root span, endpoint, and asyncId
      const rootSpans = new Set()
      const endpoints = new Set()
      const asyncIds = new Set()
      const spans = new Map()
      const strings = profile.stringTable
      const tsKey = strings.dedup('end_timestamp_ns')
      const spanKey = strings.dedup('span id')
      const rootSpanKey = strings.dedup('local root span id')
      const endpointKey = strings.dedup('trace endpoint')
      const threadNameKey = strings.dedup('thread name')
      const threadIdKey = strings.dedup('thread id')
      const osThreadIdKey = strings.dedup('os thread id')
      const asyncIdKey = strings.dedup('async id')
      const threadNameValue = strings.dedup('Main Event Loop')
      const nonJSThreadNameValue = strings.dedup('Non-JS threads')

      const asyncIdWorks = require('semifies')(process.versions.node, '>=22.10.0')
      for (const sample of profile.sample) {
        let ts, spanId, rootSpanId, endpoint, threadName, threadId, osThreadId, asyncId
        for (const label of sample.label) {
          switch (label.key) {
            case tsKey: ts = label.num; break
            case spanKey: spanId = label.str; break
            case rootSpanKey: rootSpanId = label.str; break
            case endpointKey: endpoint = label.str; break
            case threadNameKey: threadName = label.str; break
            case threadIdKey: threadId = label.str; break
            case osThreadIdKey: osThreadId = label.str; break
            case asyncIdKey:
              asyncId = label.num
              if (asyncId === 0) {
                asyncId = undefined
              }
              break
            default: assert.fail(`Unexpected label key ${strings.dedup(label.key)} ${encoded}`)
          }
        }
        if (threadName !== nonJSThreadNameValue) {
          // Timestamp must be defined and be between process start and end time
          assert.isDefined(ts, encoded)
          assert.isNumber(osThreadId, encoded)
          assert.equal(threadId, strings.dedup('0'), encoded)
          assert.isTrue(ts <= procEnd, encoded)
          assert.isTrue(ts >= procStart, encoded)
          // Thread name must be defined and exactly equal "Main Event Loop"
          assert.equal(threadName, threadNameValue, encoded)
        } else {
          assert.equal(threadId, strings.dedup('NA'), encoded)
        }
        // Either all or none of span-related labels are defined
        if (endpoint === undefined) {
          // It is possible to catch a sample executing in tracer's startSpan so
          // that endpoint is not yet set. We'll ignore those samples.
          continue
        }
        if (spanId || rootSpanId) {
          assert.isDefined(spanId, encoded)
          assert.isDefined(rootSpanId, encoded)

          rootSpans.add(rootSpanId)
          if (spanId === rootSpanId) {
            // It is possible to catch a sample executing in the root span before
            // it entered the nested span; we ignore these too, although we'll
            // still record the root span ID as we want to assert there'll only be
            // 3 of them.
            continue
          }
          const spanData = { rootSpanId, endpoint, asyncId }
          // Record async ID so we can verify we encountered 9 different values.
          // Async ID can be sporadically missing if sampling hits an intrinsified
          // function.
          if (asyncId !== undefined) {
            asyncIds.add(asyncId)
          }
          const existingSpanData = spans.get(spanId)
          if (existingSpanData) {
            // Span's root span, endpoint, and async ID must be consistent
            // across samples.
            assert.equal(existingSpanData.rootSpanId, rootSpanId, encoded)
            assert.equal(existingSpanData.endpoint, endpoint, encoded)
            if (asyncIdWorks) {
              // Account for asyncID sporadically missing
              if (existingSpanData.asyncId === undefined) {
                existingSpanData.asyncId = asyncId
              } else if (asyncId !== undefined) {
                assert.equal(existingSpanData.asyncId, asyncId, encoded)
              }
            }
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
                assert.fail(`Unexpected endpoint value ${endpointVal} ${encoded}`)
            }
          }
        }
      }
      // Need to have a total of 9 different spans, with 9 different async IDs,
      // 3 different root spans, and 3 different endpoints.
      assert.equal(spans.size, 9, encoded)
      assert.equal(asyncIds.size, asyncIdWorks ? 9 : 0, encoded)
      assert.equal(rootSpans.size, 3, encoded)
      assert.equal(endpoints.size, 3, encoded)
    })

    it('fs timeline events work', async () => {
      const fsEvents = await gatherFilesystemTimelineEvents(cwd, 'profiler/fstest.js')
      assert.equal(fsEvents.length, 6)
      const path = fsEvents[0].path
      const fd = fsEvents[1].fd
      assert(path.endsWith('tempfile.txt'))
      assert.sameDeepMembers(fsEvents, [
        { flag: 'w', mode: '', operation: 'open', path },
        { fd, operation: 'write' },
        { fd, operation: 'close' },
        { file: path, operation: 'writeFile' },
        { operation: 'readFile', path },
        { operation: 'unlink', path }
      ])
    })

    it('dns timeline events work', async () => {
      const dnsEvents = await gatherNetworkTimelineEvents(cwd, 'profiler/dnstest.js', 'dns')
      assert.sameDeepMembers(dnsEvents, [
        { operation: 'lookup', host: 'example.org' },
        { operation: 'lookup', host: 'example.com' },
        { operation: 'lookup', host: 'datadoghq.com' },
        { operation: 'queryA', host: 'datadoghq.com' },
        { operation: 'lookupService', address: '13.224.103.60', port: 80 }
      ])
    })

    it('net timeline events work', async () => {
      // Simple server that writes a constant message to the socket.
      const msg = 'cya later!\n'
      function createServer () {
        const server = net.createServer((socket) => {
          socket.end(msg, 'utf8')
        }).on('error', (err) => {
          throw err
        })
        return server
      }
      // Create two instances of the server
      const server1 = createServer()
      try {
        const server2 = createServer()
        try {
          // Have the servers listen on ephemeral ports
          const p = new Promise(resolve => {
            server1.listen(0, () => {
              server2.listen(0, async () => {
                resolve([server1.address().port, server2.address().port])
              })
            })
          })
          const [port1, port2] = await p
          const args = [String(port1), String(port2), msg]
          // Invoke the profiled program, passing it the ports of the servers and
          // the expected message.
          const events = await gatherNetworkTimelineEvents(cwd, 'profiler/nettest.js', 'net', args)
          // The profiled program should have two TCP connection events to the two
          // servers.
          assert.sameDeepMembers(events, [
            { operation: 'connect', host: '127.0.0.1', port: port1 },
            { operation: 'connect', host: '127.0.0.1', port: port2 }
          ])
        } finally {
          server2.close()
        }
      } finally {
        server1.close()
      }
    })
  }

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

    it('records profile on process exit', () => {
      proc = fork(profilerTestFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_PROFILING_ENABLED: 1
        }
      })
      const checkTelemetry = agent.assertTelemetryReceived(_ => {}, 1000, 'generate-metrics')
      // SSI telemetry is not supposed to have been emitted when DD_INJECTION_ENABLED is absent,
      // so expect telemetry callback to time out
      return Promise.all([checkProfiles(agent, proc, timeout), expectTimeout(checkTelemetry)])
    })

    it('records SSI telemetry on process exit', () => {
      proc = fork(profilerTestFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_INJECTION_ENABLED: 'tracing',
          DD_PROFILING_ENABLED: 1
        }
      })

      function checkTags (tags) {
        assert.include(tags, 'enablement_choice:manually_enabled')
        assert.include(tags, 'heuristic_hypothetical_decision:no_span_short_lived')
        assert.include(tags, 'installation:ssi')
        // There's a race between metrics and on-shutdown profile, so tag value
        // can be either false or true but it must be present
        assert.isTrue(tags.some(tag => tag === 'has_sent_profiles:false' || tag === 'has_sent_profiles:true'))
      }

      const checkTelemetry = agent.assertTelemetryReceived(({ headers, payload }) => {
        const pp = payload.payload
        assert.equal(pp.namespace, 'profilers')
        const series = pp.series
        assert.lengthOf(series, 2)
        assert.equal(series[0].metric, 'ssi_heuristic.number_of_profiles')
        assert.equal(series[0].type, 'count')
        checkTags(series[0].tags)
        // There's a race between metrics and on-shutdown profile, so metric
        // value will be either 0 or 1
        assert.isAtMost(series[0].points[0][1], 1)

        assert.equal(series[1].metric, 'ssi_heuristic.number_of_runtime_id')
        assert.equal(series[1].type, 'count')
        checkTags(series[1].tags)
        assert.equal(series[1].points[0][1], 1)
      }, timeout, 'generate-metrics')
      return Promise.all([checkProfiles(agent, proc, timeout), checkTelemetry])
    })

    if (process.platform !== 'win32') { // PROF-8905
      it('sends a heap profile on OOM with external process', () => {
        proc = fork(oomTestFile, {
          cwd,
          execArgv: oomExecArgv,
          env: oomEnv
        })
        return checkProfiles(agent, proc, timeout, ['space'], true)
      })

      it('sends a heap profile on OOM with external process and exits successfully', () => {
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

      it('sends a heap profile on OOM with async callback', () => {
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

      it('sends heap profiles on OOM with multiple strategies', () => {
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

      it('sends a heap profile on OOM in worker thread and exits successfully', () => {
        proc = fork(oomTestFile, [1, 50], {
          cwd,
          env: { ...oomEnv, DD_PROFILING_WALLTIME_ENABLED: 0 }
        })
        return checkProfiles(agent, proc, timeout, ['space'], false, 2)
      })
    }
  })

  context('SSI heuristics', () => {
    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    describe('does not trigger for', () => {
      it('a short-lived app that creates no spans', () => {
        return heuristicsDoesNotTriggerFor([], false, false)
      })

      it('a short-lived app that creates a span', () => {
        return heuristicsDoesNotTriggerFor(['create-span'], true, false)
      })

      it('a long-lived app that creates no spans', () => {
        return heuristicsDoesNotTriggerFor(['long-lived'], false, false)
      })

      it('a short-lived app that creates no spans with the auto env var', () => {
        return heuristicsDoesNotTriggerFor([], false, true)
      })

      it('a short-lived app that creates a span with the auto env var', () => {
        return heuristicsDoesNotTriggerFor(['create-span'], true, true)
      })

      it('a long-lived app that creates no spans with the auto env var', () => {
        return heuristicsDoesNotTriggerFor(['long-lived'], false, true)
      })
    })

    it('triggers for long-lived span-creating app', () => {
      return heuristicsTrigger(false)
    })

    it('triggers for long-lived span-creating app with the auto env var', () => {
      return heuristicsTrigger(true)
    })
  })

  context('Profiler API telemetry', () => {
    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('sends profiler API telemetry', () => {
      proc = fork(profilerTestFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_PROFILING_ENABLED: 1,
          DD_PROFILING_UPLOAD_PERIOD: 1,
          TEST_DURATION_MS: 2500
        }
      })

      let requestCount = 0
      let pointsCount = 0

      const checkMetrics = agent.assertTelemetryReceived(({ _, payload }) => {
        const pp = payload.payload
        assert.equal(pp.namespace, 'profilers')
        const series = pp.series
        assert.lengthOf(series, 2)
        assert.equal(series[0].metric, 'profile_api.requests')
        assert.equal(series[0].type, 'count')
        // There's a race between metrics and on-shutdown profile, so metric
        // value will be between 1 and 3
        requestCount = series[0].points[0][1]
        assert.isAtLeast(requestCount, 1)
        assert.isAtMost(requestCount, 3)

        assert.equal(series[1].metric, 'profile_api.responses')
        assert.equal(series[1].type, 'count')
        assert.include(series[1].tags, 'status_code:200')

        // Same number of requests and responses
        assert.equal(series[1].points[0][1], requestCount)
      }, timeout, 'generate-metrics')

      const checkDistributions = agent.assertTelemetryReceived(({ _, payload }) => {
        const pp = payload.payload
        assert.equal(pp.namespace, 'profilers')
        const series = pp.series
        assert.lengthOf(series, 2)
        assert.equal(series[0].metric, 'profile_api.bytes')
        assert.equal(series[1].metric, 'profile_api.ms')

        // Same number of points
        pointsCount = series[0].points.length
        assert.equal(pointsCount, series[1].points.length)
      }, timeout, 'distributions')

      return Promise.all([checkProfiles(agent, proc, timeout), checkMetrics, checkDistributions]).then(() => {
        // Same number of requests and points
        assert.equal(requestCount, pointsCount)
      })
    })
  })

  function forkSsi (args, whichEnv) {
    const profilerEnablingEnv = whichEnv ? { DD_PROFILING_ENABLED: 'auto' } : { DD_INJECTION_ENABLED: 'profiler' }
    return fork(ssiTestFile, args, {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_INTERNAL_PROFILING_LONG_LIVED_THRESHOLD: '1300',
        ...profilerEnablingEnv
      }
    })
  }

  function heuristicsTrigger (whichEnv) {
    return checkProfiles(agent,
      forkSsi(['create-span', 'long-lived'], whichEnv),
      timeout,
      DEFAULT_PROFILE_TYPES,
      false,
      // Will receive 2 messages: first one is for the trace, second one is for the profile. We
      // only need the assertions in checkProfiles to succeed for the one with the profile.
      2)
  }

  function heuristicsDoesNotTriggerFor (args, allowTraceMessage, whichEnv) {
    return Promise.all([
      processExitPromise(forkSsi(args, whichEnv), timeout, false),
      expectTimeout(expectProfileMessagePromise(agent, 1500), allowTraceMessage)
    ])
  }
})
