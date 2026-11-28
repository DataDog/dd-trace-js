'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { once } = require('node:events')
const { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } = require('node:fs')
const { createServer } = require('node:http')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { gzipSync } = require('node:zlib')

const { describe, it } = require('mocha')
const nock = require('nock')
const sinon = require('sinon')

require('../setup/core')
const getConfig = require('../../src/config')
const { enable } = require('../../src/config/remote_config')
const log = require('../../src/log')
const processTags = require('../../src/process-tags')
const RemoteConfig = require('../../src/remote_config')
const { ACKNOWLEDGED, ERROR, UNACKNOWLEDGED } = require('../../src/remote_config/apply_states')
const { APM_TRACING_SAMPLE_RATE, ASM_ACTIVATION } = require('../../src/remote_config/capabilities')
const WasmClient = require('../../src/remote_config/wasm-client')

const wasmPath = process.env.DD_RC_TEST_WASM
const suite = wasmPath === undefined ? describe.skip : describe
const product = 'APM_TRACING'

describe('RemoteConfig WASI startup', () => {
  it('does not fall back to the legacy Agent client when the reactor cannot load', () => {
    return assertDisabledReactor(require.resolve('../../src/remote_config'),
      sinon.match.instanceOf(WebAssembly.CompileError))
  })

  for (const version of [undefined, 2, 4]) {
    const description = version === undefined
      ? 'a guest without a version export'
      : `an incomplete ABI ${version} guest`
    it(`rejects ${description} before sending Agent requests`, async () => {
      const name = Buffer.from(version === undefined ? 'no_version' : 'rc_version').toString('hex')
      const guest = Buffer.from(
        `0061736d010000000105016000017f030201000503010001071702066d656d6f727902000a${name}` +
        `00000a06010400410${version ?? 4}0b`, 'hex')
      await assertGuestRejected(guest, sinon.match.has('message', 'Incompatible Remote Config WASM ABI'))
    })
  }

  it('rejects an ABI 3 guest with the required startup exports', () => {
    const guest = bufferFaultGuest(1, '01', '7e', '01', '03')
    return assertGuestRejected(guest, sinon.match.has('message', 'Incompatible Remote Config WASM ABI'))
  })

  for (const { name, pages, offset, length } of [
    { name: 'an out-of-range offset', pages: 1, offset: '7e', length: '01' },
    { name: 'a negative length', pages: 1, offset: '00', length: '7e' },
    { name: 'a range extending past memory', pages: 0, offset: '00', length: '01' },
  ]) {
    it(`rejects a guest buffer with ${name} before sending Agent requests`, () => {
      const guest = bufferFaultGuest(pages, '01', offset, length)
      return assertGuestRejected(guest, sinon.match.instanceOf(RangeError)
        .and(sinon.match.has('message', 'Remote Config WASM buffer is outside guest memory')))
    })
  }

  it('reports a guest failure without a diagnostic buffer', () => {
    return assertGuestRejected(bufferFaultGuest(1, '7f', '00', '01'),
      sinon.match.has('message', 'Remote Config WASM ABI error'))
  })
})

suite('RemoteConfig WASI host', () => {
  it('rejects a same-version guest without raw receipt support before sending a request', async () => {
    const guest = readFileSync(wasmPath)
    const offset = guest.indexOf('rc_apply_receipts')
    assert.notEqual(offset, -1)
    guest.write('no_apply_receipts', offset)

    await assertGuestRejected(guest, sinon.match.has('message', 'Incompatible Remote Config WASM receipt export'))
  })

  it('rejects a same-version guest without watch support before sending a request', async () => {
    const guest = readFileSync(wasmPath)
    const name = 'rc_watch_finish'
    const offset = guest.indexOf(name)
    assert.notEqual(offset, -1)
    guest.write('no_watch_finish', offset)

    await assertGuestRejected(guest,
      sinon.match.has('message', `Incompatible Remote Config WASM watch export: ${name}`), true)
  })

  it('rejects a raw batch without its receipt owner before dispatching it', async () => {
    const guest = readFileSync(wasmPath)
    const offset = guest.indexOf('receiptOwner')
    assert.notEqual(offset, -1)
    guest.write('receiptOther', offset)

    await withGuest(guest, artifactPath => withAgent(async (rc, poll, requestCount) => {
      const handler = sinon.spy()
      rc.setProductHandler(product, handler)
      rc.scheduler.stop()
      const report = sinon.stub(log, 'errorWithoutTelemetry')
      try {
        await poll(assignment(1, { value: { version: 1 } }))
        sinon.assert.notCalled(handler)
        sinon.assert.calledOnceWithExactly(report, '[RC] Disabling the Remote Config WASM client',
          sinon.match.has('message', 'Invalid Remote Config WASM receipt owner'))
        assert.equal(await new Promise(resolve => rc.poll(resolve)), undefined)
        assert.equal(requestCount(), 1)
      } finally {
        report.restore()
      }
    }, artifactPath))
  })

  for (const { url, logArgs, reports } of [
    {
      url: new URL('file:///invalid-agent-endpoint'),
      logArgs: ['[RC] Error in request: %s', sinon.match(/Unsupported request protocol: file:/)],
      reports: 2,
    },
    {
      url: new URL('ftp://127.0.0.1'),
      logArgs: [
        '[RC] Disabling the Remote Config WASM client',
        sinon.match.has('message', 'remote configuration requires an absolute HTTP(S) URL'),
      ],
      reports: 1,
    },
  ]) {
    it(`settles each poll once for an unsupported ${url.protocol} Agent URL`, () => {
      const rc = createWasmRemoteConfig(url)
      const report = sinon.stub(log, 'errorWithoutTelemetry')
      try {
        for (const attempt of [1, 2]) {
          const done = sinon.spy()
          rc.poll(done)
          sinon.assert.calledOnceWithExactly(done)
          assert.equal(report.callCount, Math.min(attempt, reports))
        }
        sinon.assert.alwaysCalledWithExactly(report, ...logArgs)
      } finally {
        report.restore()
      }
    })
  }

  it('stops polling when the guest rejects the poll identity', () => {
    return withAgent(async (rc, poll, requestCount) => {
      const installed = []
      enable(rc, {
        service: 'wasm-test',
        env: 'test',
        setRemoteConfig: settings => installed.push(settings),
      }, () => {})
      rc.scheduler.stop()

      await poll(assignment(1, apmFile('sample', '0.3')))
      assert.deepEqual(installed, [{ DD_TRACE_SAMPLE_RATE: '0.3' }])

      const pollGuest = WasmClient.prototype.poll
      const rejectIdentity = sinon.stub(WasmClient.prototype, 'poll').callsFake(function (identity, interest, done) {
        pollGuest.call(this, { ...identity, runtimeId: undefined }, interest, done)
      })
      const report = sinon.stub(log, 'errorWithoutTelemetry')
      const stop = sinon.spy(rc.scheduler, 'stop')
      try {
        const before = requestCount()
        await new Promise(resolve => rc.poll(resolve))
        await new Promise(resolve => rc.poll(resolve))

        assert.equal(requestCount(), before)
        assert.deepEqual(installed, [{ DD_TRACE_SAMPLE_RATE: '0.3' }])
        sinon.assert.calledOnce(rejectIdentity)
        sinon.assert.calledOnce(stop)
        sinon.assert.calledOnceWithExactly(report, '[RC] Disabling the Remote Config WASM client',
          sinon.match.has('message', sinon.match(/missing field `runtimeId`/)))
      } finally {
        stop.restore()
        report.restore()
        rejectIdentity.restore()
      }
    })
  })

  it('settles the poll once when a raw handler failure cannot be reported', () => {
    return withAgent(async (rc, poll, requestCount) => {
      const report = sinon.stub(log, 'errorWithoutTelemetry')
      try {
        const task = { product: 'AGENT_TASK', value: { task_type: 'tracer_flare' } }
        const failure = new Error('Could not run the task')
        failure.toString = () => { throw new Error('Could not report the failure') }
        rc.setProductHandler(task.product, () => { throw failure })
        rc.scheduler.stop()

        await poll(assignment(1, task), 200, { products: [task.product] })
        sinon.assert.calledOnceWithExactly(report, '[RC] Disabling the Remote Config WASM client',
          sinon.match.has('message', 'Could not report the failure'))

        const done = sinon.spy()
        rc.poll(done)
        sinon.assert.calledOnceWithExactly(done)
        assert.equal(requestCount(), 1)
      } finally {
        report.restore()
      }
    })
  })

  it('retains the acknowledged revision after an oversized reply and accepts the next assignment', () => {
    return withAgent(async (rc, poll) => {
      const observed = []
      rc.setProductHandler(product, (action, file, id, done) => {
        observed.push(file.version)
        done()
      })
      rc.scheduler.stop()

      await poll(assignment(1, { value: { version: 1 } }))
      const oversized = assignment(2, { value: { version: 2 } })
      const [current] = await poll({ ...oversized, padding: ' '.repeat(16 * 1024 * 1024) })
      assert.equal(current.apply_state, ACKNOWLEDGED)
      assert.deepEqual(observed, [1])

      const [retained] = await poll(assignment(3, { value: { version: 3 } }))
      assert.equal(retained.version, 1)
      assert.equal(retained.apply_state, ACKNOWLEDGED)
      assert.deepEqual(observed, [1, 3])
    })
  })

  it('keeps the last assignment after a disconnect and accepts repeated response headers', () => {
    return withAgent(async (rc, poll, requestCount, holdNextReply) => {
      const observed = []
      rc.setProductHandler(product, (action, file, id, done) => {
        observed.push(file.version)
        done()
      })
      rc.scheduler.stop()
      await poll(assignment(1, { value: { version: 1 } }))

      const report = sinon.stub(log, 'errorWithoutTelemetry')
      try {
        const disconnected = holdNextReply()
        const failed = new Promise(resolve => rc.poll(resolve))
        const failedResponse = await disconnected
        failedResponse.destroy()
        assert.equal(await failed, undefined)
        assert.deepEqual(observed, [1])
        sinon.assert.calledOnceWithExactly(report, '[RC] Error in request: %s',
          sinon.match(/socket hang up|ECONNRESET/))

        const restored = holdNextReply()
        const accepted = new Promise(resolve => rc.poll(resolve))
        const response = await restored
        response.writeHead(200, { 'Set-Cookie': ['first=1', 'second=2'] })
        response.end(JSON.stringify(assignment(2, { value: { version: 2 } })))
        assert.equal(await accepted, undefined)
        assert.deepEqual(observed, [1, 2])
        const [current] = await poll({})
        assert.equal(current.apply_state, ACKNOWLEDGED)
        assert.equal(current.version, 2)
        sinon.assert.calledOnce(report)
      } finally {
        report.restore()
      }
    })
  })

  it('cancels a pending Agent request when the low-level client closes', () => {
    return withAgent(async (rc, poll, requestCount, holdNextReply) => {
      const { client, identity } = openLowLevelClient(rc.url)
      const held = holdNextReply()
      const delivered = sinon.spy()
      client.poll(identity, undefined, delivered)
      sinon.assert.notCalled(delivered)
      const reply = await held
      const closed = once(reply, 'close')
      try {
        client.close()
        await closed
        sinon.assert.notCalled(delivered)
        const unavailable = sinon.spy()
        client.poll(identity, undefined, unavailable)
        sinon.assert.calledOnceWithExactly(unavailable,
          sinon.match.has('message', 'Remote Config WASM client is unavailable or already polling'))
        assert.equal(requestCount(), 1)
      } finally {
        client.close()
        reply.destroy()
      }
    })
  })

  it('cancels a timed-out request without removing the last acknowledged assignment', () => {
    return withAgent(async (rc, poll, requestCount, holdNextReply) => {
      const observed = []
      rc.setProductHandler(product, (action, file, id, done) => {
        observed.push(file.version)
        done()
      })
      rc.scheduler.stop()
      await poll(assignment(1, { value: { version: 1 } }))

      const before = requestCount()
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const held = holdNextReply()
        const done = sinon.spy()
        rc.poll(done)
        const response = await held
        const closed = once(response, 'close')
        try {
          await clock.tickAsync(2000)
          sinon.assert.calledOnceWithExactly(done)
          await closed
          assert.equal(requestCount(), before + 1)
          assert.deepEqual(observed, [1])

          const [retained] = await poll(assignment(2, { value: { version: 2 } }))
          assert.equal(retained.version, 1)
          assert.equal(retained.apply_state, ACKNOWLEDGED)
          assert.deepEqual(observed, [1, 2])
          sinon.assert.calledOnce(done)
        } finally {
          response.destroy()
        }
      } finally {
        clock.restore()
      }
    })
  })

  it('polls and acknowledges assignments through a Unix socket Agent', async function () {
    if (process.platform === 'win32') {
      this.skip()
    }
    const directory = mkdtempSync(join(tmpdir(), 'rc-'))
    const interceptionActive = nock.isActive()
    try {
      if (interceptionActive) {
        nock.restore()
      }
      await withAgent(async (rc, poll) => {
        const installed = []
        rc.setProductHandler(product, (action, file, id, done) => {
          installed.push(file.version)
          done()
        })
        rc.scheduler.stop()

        await poll(assignment(1, { value: { version: 1 } }))
        const [applied] = await poll({})
        assert.deepEqual(installed, [1])
        assert.equal(applied.apply_state, ACKNOWLEDGED)
      }, wasmPath, join(directory, 'agent.sock'))
    } finally {
      if (interceptionActive) {
        nock.activate()
      }
      rmdirSync(directory)
    }
  })

  for (const { failure, message } of [
    { failure: new Error('WAF installation failed'), message: 'WAF installation failed' },
    { failure: 'invalid WAF state', message: 'Remote Config batch handler threw' },
  ]) {
    it(`reports "${message}" without losing other batch decisions`, () => {
      return withAgent(async (rc, poll) => {
        const batchProduct = 'ASM'
        const received = []
        const fallback = []
        const committed = { product: batchProduct, id: 'committed', version: 1, value: {} }
        const failed = { product: batchProduct, id: 'failed', version: 1, value: {} }
        const interest = { products: [product, batchProduct] }

        rc.setProductHandler(product, (action, file, id, done) => {
          received.push(file.version)
          done()
        })
        rc.setProductHandler(batchProduct, (action, file, id) => fallback.push(id))
        rc.setBatchHandler([batchProduct], transaction => {
          const applied = transaction.toApply.find(file => file.id === committed.id)
          transaction.ack(applied.path)
          throw failure
        })
        rc.scheduler.stop()

        await poll(assignment(1, committed, failed, { value: { version: 1 } }), 200, interest)
        assert.deepEqual(received, [1])
        assert.deepEqual(fallback, [])

        const outcomes = await poll(assignment(2, committed, failed, { value: { version: 2 } }), 200, interest)
        const states = new Map(outcomes.map(state => [state.id, state]))
        assert.equal(states.get(committed.id).apply_state, ACKNOWLEDGED)
        assert.equal(states.get(failed.id).apply_state, ERROR)
        assert.equal(states.get(failed.id).apply_error, message)
        assert.equal(states.get('sample').apply_state, ACKNOWLEDGED)
        assert.deepEqual(received, [1, 2])
        assert.deepEqual(fallback, [])
      })
    })
  }

  it('dispatches verified revisions and sends only the current outcome to the Agent', () => {
    return withAgent(async (rc, poll) => {
      const observed = []
      const ack = []
      rc.setProductHandler(product, (action, file, id, done) => {
        observed.push({ action, file, id })
        ack.push(done)
      })
      rc.scheduler.stop()

      const first = { version: 1 }
      const second = { version: 2 }
      assert.deepEqual(await poll(assignment(1, { value: first })), [])
      assert.deepEqual(observed, [{ action: 'apply', file: first, id: 'sample' }])

      assert.equal((await poll(assignment(2, { value: second })))[0].apply_state, UNACKNOWLEDGED)
      assert.deepEqual(observed[1], { action: 'modify', file: second, id: 'sample' })
      ack[0](new Error('old outcome'))
      for (const status of [204, 404]) {
        const [unchanged] = await poll({}, status)
        assert.equal(unchanged.version, 2)
        assert.equal(unchanged.apply_state, UNACKNOWLEDGED)
        assert.equal(observed.length, 2)
      }

      ack[1]()
      assert.equal((await poll(assignment(3)))[0].apply_state, ACKNOWLEDGED)
      assert.deepEqual(observed[2], { action: 'unapply', file: second, id: 'sample' })
      ack[2](new Error('local removal outcome'))
      assert.deepEqual(await poll({}), [])
      assert.equal(observed.length, 3)
    })
  })

  for (const { phase, state, error } of [
    { phase: 'pending', state: UNACKNOWLEDGED },
    { phase: 'acknowledged', state: ACKNOWLEDGED },
    { phase: 'rejected', state: ERROR, error: new Error('installation failed') },
  ]) {
    it(`renews the receipt for a ${phase} application of unchanged content`, () => {
      return withAgent(async (rc, poll) => {
        const calls = []
        rc.setProductHandler(product, (action, file, id, done) => {
          calls.push({ action, file, id, done })
        })
        rc.scheduler.stop()

        const file = { value: { sampleRate: 0.5 } }
        await poll(assignment(1, file))
        assert.equal(calls.length, 1)
        assert.equal(calls[0].action, 'apply')
        assert.deepEqual(calls[0].file, file.value)
        const { done } = calls[0]
        if (state !== UNACKNOWLEDGED) done(error)

        const cached = assignment(2, file)
        cached.target_files.length = 0
        await poll(cached)
        const [renewed] = await poll({})
        assert.equal(renewed.version, 2)
        assert.equal(renewed.apply_state, state)
        if (error !== undefined) assert.equal(renewed.apply_error, error.toString())
        assert.equal(calls.length, 1)

        if (state === UNACKNOWLEDGED) {
          done()
          const [completed] = await poll({})
          assert.equal(completed.version, 2)
          assert.equal(completed.apply_state, ACKNOWLEDGED)
        }
      })
    })
  }

  it('reports capability changes without dropping the active watch capabilities', () => {
    return withAgent(async (rc, poll) => {
      rc.watchValues({
        product,
        capabilities: APM_TRACING_SAMPLE_RATE,
        project: () => ({ decisions: new Map() }),
      })
      rc.scheduler.stop()

      await poll({}, 204, { capabilities: APM_TRACING_SAMPLE_RATE })
      rc.updateCapabilities(ASM_ACTIVATION, true)
      await poll({}, 204, { capabilities: APM_TRACING_SAMPLE_RATE | ASM_ACTIVATION })
      rc.updateCapabilities(ASM_ACTIVATION, false)
      await poll({}, 204, { capabilities: APM_TRACING_SAMPLE_RATE })
    })
  })

  it('keeps a parse error when an earlier raw revision completes late', () => {
    return withAgent(async (rc, poll) => {
      const acks = []
      rc.setProductHandler(product, (action, file, id, done) => acks.push(done))
      rc.scheduler.stop()

      await poll(assignment(1, { value: { valid: true } }))
      await poll(assignment(2, { raw: 'not JSON' }))
      assert.equal(acks.length, 1)
      acks[0]()

      const [state] = await poll({})
      assert.equal(state.version, 2)
      assert.equal(state.apply_state, ERROR)
      assert.match(state.apply_error, /SyntaxError/)
    })
  })

  for (const { reason, character, size } of [
    { reason: 'before encoding', character: 'x', size: 16 * 1024 * 1024 + 1 },
    { reason: 'after escaping', character: '\u0000', size: 3 * 1024 * 1024 },
  ]) {
    it(`reports a raw diagnostic that exceeds the limit ${reason} without blocking the other outcomes`, () => {
      return withAgent(async (rc, poll) => {
        rc.setProductHandler(product, (action, file, id, done) => {
          if (id === 'rejected') {
            done(new Error(character.repeat(size)))
          } else {
            done()
          }
        })
        rc.scheduler.stop()

        await poll(assignment(1, { id: 'rejected', value: {} }, { id: 'accepted', value: {} }))
        const states = new Map((await poll({})).map(state => [state.id, state]))
        const rejected = states.get('rejected')
        const accepted = states.get('accepted')
        assert.ok(rejected)
        assert.ok(accepted)
        assert.equal(rejected.apply_state, ERROR)
        assert.equal(rejected.apply_error, 'Remote Config diagnostic exceeds the receipt plan limit')
        assert.equal(accepted.apply_state, ACKNOWLEDGED)
      })
    })
  }

  it('reports all raw error states when their diagnostics exceed the poll limit', () => {
    return withAgent(async (rc, poll) => {
      const diagnostic = '\u0000'.repeat(1_400_000)
      rc.setProductHandler(product, (action, file, id, done) => done(new Error(id + diagnostic)))
      rc.scheduler.stop()

      await poll(assignment(1, { id: 'first', value: {} }, { id: 'second', value: {} }))
      const states = await poll({})
      assert.deepEqual(states.map(state => state.id).sort(), ['first', 'second'])
      for (const state of states) {
        assert.equal(state.apply_state, ERROR)
        assert.equal(state.apply_error, '')
      }
    })
  })

  it('projects APM values, reports per-file decisions, and retries installation without a new assignment', () => {
    return withAgent(async (rc, poll) => {
      const installed = []
      let attempts = 0
      let fail = false
      enable(rc, {
        service: 'wasm-test',
        env: 'test',
        setRemoteConfig (settings) {
          attempts++
          if (fail) {
            fail = false
            throw new Error('installation failed')
          }
          installed.push(settings)
        },
      }, () => {})
      rc.scheduler.stop()

      await poll({})
      assert.deepEqual(installed, [])
      await poll(assignment(1))
      assert.deepEqual(installed, [null])

      const first = apmFile('z-first', '0.2')
      const second = apmFile('a-second', '0.7')
      const rejected = { id: 'rejected', value: null }
      const ignored = apmFile('ignored', '0.9', 'another-service')
      await poll(assignment(2, ignored))
      const [retained] = await poll({})
      assert.equal(retained.id, ignored.id)
      assert.equal(retained.apply_state, ACKNOWLEDGED)
      assert.deepEqual(installed, [null])

      fail = true
      await poll(assignment(3, first, second, rejected, ignored))
      assert.deepEqual(installed, [null])
      const retry = new Map((await poll({})).map(state => [state.id, state]))
      assert.equal(retry.get(first.id).apply_state, ERROR)
      assert.equal(retry.get(second.id).apply_error, 'installation failed')
      assert.equal(retry.get(rejected.id).apply_state, ERROR)
      assert.match(retry.get(rejected.id).apply_error, /expected.*object/i)
      assert.equal(retry.get(ignored.id).apply_state, ACKNOWLEDGED)
      assert.deepEqual(installed, [null, { DD_TRACE_SAMPLE_RATE: '0.7' }])

      const recovered = new Map((await poll({})).map(state => [state.id, state]))
      assert.equal(recovered.get(first.id).apply_state, ACKNOWLEDGED)
      assert.equal(recovered.get(second.id).apply_state, ACKNOWLEDGED)
      assert.equal(recovered.get(rejected.id).apply_state, ERROR)
      assert.equal(attempts, 3)

      const updated = apmFile('z-first', '0.4')
      await poll(assignment(4, { ...second, version: 3 }, updated))
      assert.deepEqual(installed.at(-1), { DD_TRACE_SAMPLE_RATE: '0.7' })
      await poll(assignment(5, { ...updated, version: 4 }))
      assert.deepEqual(installed.at(-1), { DD_TRACE_SAMPLE_RATE: '0.4' })

      const cached = assignment(6, updated)
      cached.target_files.length = 0
      const installCount = installed.length
      await poll(cached)
      const [applied] = await poll({})
      assert.equal(applied.id, updated.id)
      assert.equal(applied.version, 6)
      assert.equal(applied.apply_state, ACKNOWLEDGED)
      assert.equal(installed.length, installCount)
      assert.deepEqual(installed.at(-1), { DD_TRACE_SAMPLE_RATE: '0.4' })
    })
  })

  it('reinstalls APM settings when the winning environment alias changes', () => {
    return withAgent(async (rc, poll) => {
      const config = getConfig({ service: 'wasm-test', env: 'test', sampleRate: 0.75 })
      enable(rc, config, () => {})
      rc.scheduler.stop()

      const datadog = { id: 'datadog', value: { sdk_config: { config: { DD_SERVICE_NAME: 'first' } } } }
      const otel = { id: 'otel', value: { sdk_config: { config: { OTEL_SERVICE_NAME: 'second' } } } }
      const serviceTarget = { service_target: { service: 'wasm-test' } }

      try {
        await poll(assignment(1, datadog, { ...otel, value: { ...otel.value, ...serviceTarget } }))
        assert.equal(config.service, 'first')

        await poll(assignment(2, { ...datadog, value: { ...datadog.value, ...serviceTarget } }, otel))
        assert.equal(config.service, 'second')
      } finally {
        await poll(assignment(3))
      }
    })
  })

  it('keeps legacy precedence when equal-priority APM files become eligible', () => {
    return withAgent(async (rc, poll) => {
      const config = getConfig({ service: 'wasm-test', env: 'test', sampleRate: 0.75 })
      enable(rc, config, () => {})
      rc.scheduler.stop()

      await poll(assignment(1,
        apmFile('first', '0.3', 'another-service'),
        apmFile('second', '0.7', 'another-service'),
        apmFile('modified', '0.6', 'another-service')))
      assert.equal(config.sampleRate, 0.75)

      const first = { ...apmFile('first', '0.3', 'wasm-test'), version: 2 }
      const second = { ...apmFile('second', '0.7', 'wasm-test'), version: 2 }
      const ignored = { ...apmFile('modified', '0.6', 'another-service'), version: 1 }
      await poll(assignment(2, second, first, ignored))
      assert.equal(config.sampleRate, 0.3)

      const modified = apmFile('modified', '0.6', 'wasm-test')
      const added = { ...apmFile('added', '0.9', 'wasm-test'), version: 3 }
      const mixed = assignment(3, modified, added, first, second)
      mixed.target_files.length = 2
      await poll(mixed)
      assert.equal(config.sampleRate, 0.6)

      const withdrawn = assignment(4, added, first, second)
      withdrawn.target_files.length = 0
      await poll(withdrawn)
      assert.equal(config.sampleRate, 0.9)
    })
  })

  it('keeps the installed APM value until a replacement is accepted or the file is removed', () => {
    return withAgent(async (rc, poll) => {
      let installed
      let fail = false
      enable(rc, {
        service: 'wasm-test',
        env: 'test',
        setRemoteConfig (settings) {
          if (fail) {
            fail = false
            throw new Error('installation failed')
          }
          installed = settings
        },
      }, () => {})
      rc.scheduler.stop()

      await poll(assignment(1, apmFile('sample', '0.2')))
      assert.deepEqual(installed, { DD_TRACE_SAMPLE_RATE: '0.2' })

      await poll(assignment(2, { raw: 'not JSON' }))
      assert.deepEqual(installed, { DD_TRACE_SAMPLE_RATE: '0.2' })
      const [rejected] = await poll({}, 204)
      assert.equal(rejected.apply_state, ERROR)
      assert.match(rejected.apply_error, /unexpected|invalid JSON/i)

      fail = true
      await poll(assignment(3, apmFile('sample', '0.4')))
      assert.deepEqual(installed, { DD_TRACE_SAMPLE_RATE: '0.2' })
      await poll(assignment(4, apmFile('sample', '0.9', 'another-service')))
      assert.deepEqual(installed, { DD_TRACE_SAMPLE_RATE: '0.2' })
      const [ignored] = await poll({}, 204)
      assert.equal(ignored.version, 4)
      assert.equal(ignored.apply_state, ACKNOWLEDGED)

      await poll(assignment(5, apmFile('sample', '0.7')))
      assert.deepEqual(installed, { DD_TRACE_SAMPLE_RATE: '0.7' })
      await poll(assignment(6))
      assert.equal(installed, null)
    })
  })

  it('restores local APM settings when withdrawing a failed installation after an empty snapshot', () => {
    return withAgent(async (rc, poll) => {
      const config = getConfig({ service: 'wasm-test', env: 'test', sampleRate: 0.75, url: 'http://127.0.0.1:8126' })
      const initialUrl = config.url.href
      enable(rc, config, () => {})
      rc.scheduler.stop()

      await poll(assignment(1))
      await poll(assignment(2, {
        id: 'sample',
        value: {
          sdk_config: {
            config: {
              DD_TRACE_SAMPLE_RATE: '0.2',
              DD_TRACE_AGENT_URL: 'https://',
            },
          },
        },
      }))
      const [failed] = await poll({}, 204)
      assert.equal(failed.apply_state, ERROR)
      assert.match(failed.apply_error, /invalid url/i)

      await poll(assignment(3))
      assert.equal(config.sampleRate, 0.75)
      assert.equal(config.url.href, initialUrl)
    })
  })

  it('matches later APM assignments against the target at watch registration', () => {
    return withAgent(async (rc, poll) => {
      const config = getConfig({ service: 'wasm-test', env: 'test', sampleRate: 0.75 })
      enable(rc, config, () => {})
      rc.scheduler.stop()

      await poll(assignment(1, { id: 'environment', value: { sdk_config: { config: { DD_ENV: 'canary' } } } }))
      assert.equal(config.env, 'canary')

      await poll(assignment(2, {
        id: 'sampling',
        value: {
          service_target: { env: 'test' },
          sdk_config: { config: { DD_TRACE_SAMPLE_RATE: '0.4' } },
        },
      }))
      assert.equal(config.sampleRate, 0.4)
    })
  })

  for (const fileCount of [255, 256, 257]) {
    it(`installs and acknowledges an APM assignment of ${fileCount} files`, () => {
      return withAgent(async (rc, poll) => {
        const installed = []
        enable(rc, {
          service: 'wasm-test',
          env: 'test',
          setRemoteConfig (settings) {
            installed.push(settings)
          },
        }, () => {})
        rc.scheduler.stop()

        const files = []
        for (let index = 0; index < fileCount; index++) {
          const rate = index === fileCount - 1 ? '0.7' : '0.2'
          files.push(apmFile(`config-${String(index).padStart(3, '0')}`, rate))
        }

        await poll(assignment(1, ...files))
        assert.deepEqual(installed, [{ DD_TRACE_SAMPLE_RATE: '0.7' }])
        const states = await poll({})
        assert.equal(states.length, fileCount)
        assert.ok(states.every(state => state.apply_state === ACKNOWLEDGED))
      })
    })
  }

  it('keeps watch receipts separate from asynchronous raw delivery in a mixed assignment', () => {
    return withAgent(async (rc, poll) => {
      const installed = []
      const raw = []
      const acks = []
      const probe = { id: 'probe', product: 'LIVE_DEBUGGING', value: { probe: true } }
      let subscribed = false
      enable(rc, {
        service: 'wasm-test',
        env: 'test',
        setRemoteConfig: settings => installed.push(settings),
      }, () => {
        if (subscribed) return
        subscribed = true
        rc.setProductHandler(probe.product, (action, file, id, ack) => {
          raw.push({ action, file, id })
          acks.push(ack)
        })
      })
      rc.scheduler.stop()

      await poll(assignment(1))
      const files = Array.from({ length: 257 }, (_, index) => apmFile(`apm-${index}`, '0.7'))
      const interest = { products: [product, probe.product] }
      await poll(assignment(2, ...files, probe), 200, interest)
      assert.deepEqual(installed, [null, { DD_TRACE_SAMPLE_RATE: '0.7' }])
      assert.deepEqual(raw, [{ action: 'apply', file: probe.value, id: probe.id }])

      const states = await poll({}, 200, interest)
      assert.equal(states.length, files.length + 1)
      for (const state of states) {
        assert.equal(state.apply_state, state.id === probe.id ? UNACKNOWLEDGED : ACKNOWLEDGED)
      }

      acks[0]()
      const completed = await poll({}, 200, interest)
      assert.ok(completed.every(state => state.apply_state === ACKNOWLEDGED))
      assert.equal(installed.length, 2)
      assert.equal(raw.length, 1)
    })
  })

  for (const fileCount of [254, 255, 256, 257]) {
    it(`keeps polling with ${fileCount} delayed raw acknowledgments`, () => {
      return withAgent(async (rc, poll) => {
        const probeProduct = 'LIVE_DEBUGGING'
        const acks = new Map()
        rc.setProductHandler(probeProduct, (action, file, id, acknowledge) => {
          assert.equal(action, 'apply')
          assert.equal(file.id, id)
          acks.set(id, acknowledge)
        })
        rc.scheduler.stop()

        const files = Array.from({ length: fileCount }, (_, index) => {
          const id = `probe-${index}`
          return { id, product: probeProduct, value: { id } }
        })
        const interest = { products: [probeProduct] }
        await poll(assignment(1, ...files), 200, interest)
        assert.equal(acks.size, fileCount)

        const pending = await poll({}, 200, interest)
        assert.equal(pending.length, fileCount)
        assert.ok(pending.every(state => state.apply_state === UNACKNOWLEDGED))

        for (const acknowledge of acks.values()) acknowledge()
        const completed = await poll({}, 200, interest)
        assert.equal(completed.length, fileCount)
        assert.ok(completed.every(state => state.apply_state === ACKNOWLEDGED))
      })
    })
  }

  it('bounds a multibyte watch diagnostic and still retries the full assignment', () => {
    return withAgent(async (rc, poll) => {
      const installed = []
      let pendingFailure = true
      enable(rc, {
        service: 'wasm-test',
        env: 'test',
        setRemoteConfig (settings) {
          if (pendingFailure) {
            pendingFailure = false
            throw new Error('é'.repeat(33_000))
          }
          installed.push(settings)
        },
      }, () => {})
      rc.scheduler.stop()

      const files = Array.from({ length: 257 }, (_, index) => apmFile(`apm-${index}`, '0.7'))
      await poll(assignment(1, ...files))
      assert.deepEqual(installed, [])

      const failed = await poll({})
      assert.equal(failed.length, files.length)
      for (const state of failed) {
        assert.equal(state.apply_state, ERROR)
        assert.equal(state.apply_error, 'Remote Config watch diagnostic exceeds the plan limit')
      }
      assert.deepEqual(installed, [{ DD_TRACE_SAMPLE_RATE: '0.7' }])
      const retried = await poll({})
      assert.equal(retried.length, files.length)
      assert.ok(retried.every(state => state.apply_state === ACKNOWLEDGED))
    })
  })

  for (const failure of [undefined, 'installation failed']) {
    it(`reports and retries when APM installation throws a non-Error value (${typeof failure})`, () => {
      return withAgent(async (rc, poll) => {
        const installed = []
        let pendingFailure = true
        enable(rc, {
          service: 'wasm-test',
          env: 'test',
          setRemoteConfig (settings) {
            if (pendingFailure) {
              pendingFailure = false
              throw failure
            }
            installed.push(settings)
          },
        }, () => {})
        rc.scheduler.stop()

        await poll(assignment(1, apmFile('sample', '0.7')))
        assert.deepEqual(installed, [])

        const [failed] = await poll({})
        assert.equal(failed.apply_state, ERROR)
        assert.equal(failed.apply_error, 'Remote Config value processing threw a non-Error value')
        assert.deepEqual(installed, [{ DD_TRACE_SAMPLE_RATE: '0.7' }])
        assert.equal((await poll({}))[0].apply_state, ACKNOWLEDGED)
      })
    })
  }
})
/**
 * @typedef {{ id: string, version: number, apply_state: number, apply_error: string }} AgentOutcome
 * @typedef {{ products: string[], capabilities?: bigint }} ExpectedInterest
 * @typedef {(reply: object, code?: number, interest?: ExpectedInterest) => Promise<AgentOutcome[]>} Poll
 * @typedef {() => Promise<import('node:http').ServerResponse>} HoldReply
 */

/**
 * @param {number} pages
 * @param {string} allocation
 * @param {string} offset
 * @param {string} length
 * @param {string} [version]
 */
function bufferFaultGuest (pages, allocation, offset, length, version = '04') {
  const names = ['memory', 'rc_version', 'rc_apply', 'rc_alloc', 'rc_buffer_ptr', 'rc_buffer_len', 'rc_error']
  const exports = names.map((name, index) => {
    const bytes = Buffer.from(name).toString('hex')
    const binding = index === 0 ? '0200' : `000${index - 1}`
    return `${name.length.toString(16).padStart(2, '0')}${bytes}${binding}`
  }).join('')
  const size = (exports.length / 2 + 1).toString(16)
  const code = [version, '00', allocation, offset, length, '00'].map(value => `040041${value}0b`).join('')
  return Buffer.from('0061736d010000000112036000017f60047f7f7f7f017f60017f017f030706000102020200' +
    `050301000${pages}07${size}07${exports}0a1f06${code}`, 'hex')
}

/**
 * @param {Buffer} guest
 * @param {import('sinon').SinonMatcher} expectedError
 * @param {boolean} [withWatch]
 */
function assertGuestRejected (guest, expectedError, withWatch) {
  return withGuest(guest, artifactPath => assertDisabledReactor(artifactPath, expectedError, withWatch))
}

/**
 * @param {Buffer} guest
 * @param {(artifactPath: string) => Promise<void>} run
 */
async function withGuest (guest, run) {
  const directory = mkdtempSync(join(tmpdir(), 'rc-abi-'))
  const artifactPath = join(directory, 'reactor.wasm')
  writeFileSync(artifactPath, guest)
  try {
    await run(artifactPath)
  } finally {
    unlinkSync(artifactPath)
    rmdirSync(directory)
  }
}

/**
 * @param {string} artifactPath
 * @param {import('sinon').SinonMatcher} expectedError
 * @param {boolean} [withWatch]
 */
function assertDisabledReactor (artifactPath, expectedError, withWatch = false) {
  return withAgent(async (rc, poll, requestCount) => {
    if (withWatch) {
      enable(rc, { service: 'wasm-test', env: 'test', setRemoteConfig () {} }, () => {})
      rc.scheduler.stop()
    }
    const report = sinon.stub(log, 'errorWithoutTelemetry')
    try {
      assert.equal(await new Promise(resolve => rc.poll(resolve)), undefined)
      assert.equal(requestCount(), 0)
      sinon.assert.calledOnceWithExactly(report, '[RC] Disabling the Remote Config WASM client', expectedError)

      assert.equal(await new Promise(resolve => rc.poll(resolve)), undefined)
      assert.equal(requestCount(), 0)
      sinon.assert.calledOnce(report)
    } finally {
      report.restore()
    }
  }, artifactPath)
}

/**
 * @param {(client: RemoteConfig, poll: Poll, requestCount: () => number, holdReply: HoldReply) => Promise<void>} run
 * @param {string} [artifactPath]
 * @param {string} [socketPath]
 */
async function withAgent (run, artifactPath = wasmPath, socketPath) {
  const requests = []
  let body
  let status
  /** @type {((response: import('node:http').ServerResponse) => void) | undefined} */
  let holdReply
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({ path: request.url, method: request.method, body: JSON.parse(Buffer.concat(chunks).toString()) })
    if (holdReply !== undefined) {
      const hold = holdReply
      holdReply = undefined
      hold(response)
      return
    }
    if (status === 204) {
      response.writeHead(status)
      response.end()
      return
    }
    response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' })
    response.end(body)
  })
  if (socketPath === undefined) {
    server.listen(0, '127.0.0.1')
  } else {
    server.listen(socketPath)
  }
  await once(server, 'listening')

  try {
    const url = socketPath === undefined
      ? new URL(`http://127.0.0.1:${server.address().port}`)
      : new URL(`unix://${socketPath}`)
    const rc = createWasmRemoteConfig(url, artifactPath)

    /** @type {Poll} */
    async function poll (reply, code = 200, interest) {
      body = gzipSync(JSON.stringify(reply))
      status = code
      const before = requests.length
      assert.equal(await new Promise(resolve => rc.poll(resolve)), undefined)
      assert.equal(requests.length, before + 1)
      const request = requests.at(-1)
      assert.equal(request.method, 'POST')
      assert.equal(request.path, '/v0.7/config')
      const client = request.body.client
      assert.deepEqual(client.products.sort(), interest?.products ?? [product])
      if (interest?.capabilities !== undefined) {
        const hex = Buffer.from(client.capabilities, 'base64').toString('hex')
        assert.equal(BigInt(`0x${hex}`), interest.capabilities)
      }
      return client.state.config_states
    }

    await run(rc, poll, () => requests.length, () => new Promise(resolve => { holdReply = resolve }))
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

/** @param {URL} url */
function openLowLevelClient (url) {
  assert.ok(wasmPath)
  const identity = { clientId: 'probe', runtimeId: 'wasm-runtime', tags: [], extraServices: [] }
  const client = new WasmClient(wasmPath, {
    url: url.href,
    identity,
    interest: { products: [product], capabilities: [] },
    target: { service: 'wasm-test', env: 'test', appVersion: '', processTags: [] },
    language: 'nodejs',
    tracerVersion: '0.0.0',
    timeoutMs: 2000,
  }, url)
  return { client, identity }
}

/**
 * @param {URL} url
 * @param {string} [artifactPath]
 */
function createWasmRemoteConfig (url, artifactPath = wasmPath) {
  processTags.initialize()
  const env = process.env
  process.env = { ...env, _DD_REMOTE_CONFIG_WASM_PATH: artifactPath }
  try {
    return new RemoteConfig({
      url,
      service: 'wasm-test',
      tags: { 'runtime-id': 'wasm-runtime' },
      remoteConfig: { pollInterval: 5 },
    })
  } finally {
    process.env = env
  }
}

/**
 * @param {string} id
 * @param {string} sampleRate
 * @param {string} [service]
 */
function apmFile (id, sampleRate, service) {
  return {
    id,
    value: {
      sdk_config: { config: { DD_TRACE_SAMPLE_RATE: sampleRate } },
      service_target: service === undefined ? undefined : { service },
    },
  }
}

/**
 * @param {number} version
 * @param {...{ id?: string, product?: string, version?: number, value?: unknown, raw?: string }} files
 */
function assignment (version, ...files) {
  const targets = {}
  const targetFiles = []
  for (const file of files) {
    const path = `datadog/2/${file.product ?? product}/${file.id ?? 'sample'}/config`
    const bytes = Buffer.from(file.raw ?? JSON.stringify(file.value))
    targets[path] = {
      custom: { v: file.version ?? version },
      hashes: { sha256: createHash('sha256').update(bytes).digest('hex') },
      length: bytes.length,
    }
    targetFiles.push({ path, raw: bytes.toString('base64') })
  }
  const signed = { custom: { opaque_backend_state: 'test-state' }, targets, version }
  return {
    roots: [],
    targets: Buffer.from(JSON.stringify({ signed })).toString('base64'),
    target_files: targetFiles,
    client_configs: targetFiles.map(file => file.path),
  }
}
