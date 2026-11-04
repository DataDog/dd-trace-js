'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { once } = require('node:events')
const net = require('node:net')

const { afterEach, beforeEach, describe, it } = require('mocha')
const semver = require('semver')
const sinon = require('sinon')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const Parser = require('../../../versions/ioredis@5').get('redis-parser')

describe('ioredis replay', () => {
  withVersions('ioredis', 'ioredis', (version, moduleName, resolvedVersion) => {
    let Redis
    let tracer
    let redis
    let other
    let spans
    let collect

    beforeEach(async () => {
      redis = other = undefined
      tracer = await agent.load(['ioredis'])
      Redis = require(`../../../versions/ioredis@${version}`).get()
      spans = []
      collect = traces => spans.push(...traces.flat())
      agent.subscribe(collect)
    })

    afterEach(async () => {
      redis?.disconnect()
      other?.disconnect()
      agent.unsubscribe(collect)
      await agent.close()
    })

    /**
     * @param {string} rawCommand
     * @param {number} [expected]
     */
    async function assertSpans (rawCommand, expected = 1) {
      await redis.get('replay-marker')
      await agent.assertSomeTraces(() => {
        assert.ok(spans.some(span => span.meta['redis.raw_command'] === 'GET replay-marker'))
        assert.equal(spans.filter(span => span.meta['redis.raw_command'] === rawCommand).length, expected)
      })
    }

    for (const [name, preventChanges] of [
      ['non-extensible', Object.preventExtensions],
      ['sealed', Object.seal],
      ['frozen', Object.freeze],
    ]) {
      for (const ready of [false, true]) {
        it(`supports a ${name} command ${ready ? 'when ready' : 'through the offline queue'}`, async function () {
          if (semver.gte(resolvedVersion, '5.11.0')) this.skip()
          redis = new Redis({ lazyConnect: true })
          if (ready) await redis.connect()
          const key = `replay-${name}-${ready}`
          const command = preventChanges(new Redis.Command('set', [key, 'value']))
          assert.equal((await redis.sendCommand(command)).toString(), 'OK')
          await assertSpans(`SET ${key} value`)
        })
      }
    }

    /**
     * @param {import('ioredis').Redis} client
     * @param {import('ioredis').Command} command
     */
    function sendWithoutBookkeeping (client, command) {
      const accesses = [
        sinon.spy(WeakMap.prototype, 'get'),
        sinon.spy(WeakMap.prototype, 'has'),
        sinon.spy(WeakMap.prototype, 'set'),
        sinon.spy(WeakMap.prototype, 'delete'),
        sinon.spy(WeakSet.prototype, 'has'),
        sinon.spy(WeakSet.prototype, 'add'),
        sinon.spy(WeakSet.prototype, 'delete'),
      ]
      let pending
      try {
        pending = client.sendCommand(command)
      } finally {
        for (const access of accesses) access.restore()
      }
      for (const access of accesses) {
        assert.equal(access.calledWith(command), false)
        assert.equal(access.calledWith(command.promise), false)
      }
      assert.deepEqual(Object.getOwnPropertySymbols(command), [])
      return pending
    }

    it('does not mark commands on an idle connection', async () => {
      redis = new Redis()
      await once(redis, 'ready')
      await sendWithoutBookkeeping(redis, new Redis.Command('get', ['replay-ready']))
      await assertSpans('GET replay-ready')
    })

    it('does no command bookkeeping when enqueueing or when another client has queued commands', async () => {
      redis = new Redis({ lazyConnect: true })
      other = new Redis()
      await once(other, 'ready')
      const command = new Redis.Command('set', ['replay-queued', 'value'])
      const queued = sendWithoutBookkeeping(redis, command)
      const ready = sendWithoutBookkeeping(other, new Redis.Command('get', ['replay-unrelated']))
      await Promise.all([queued, ready])
      await assertSpans('SET replay-queued value')
      await assertSpans('GET replay-unrelated')
    })

    it('deduplicates commands enqueued after a ready stream becomes unwritable', async () => {
      redis = new Redis()
      await once(redis, 'ready')
      redis.stream.destroy()
      await sendWithoutBookkeeping(redis, new Redis.Command('set', ['replay-unwritable', 'value']))
      await assertSpans('SET replay-unwritable value')
    })

    it('deduplicates the offline queue when resending unfulfilled commands is disabled', async () => {
      redis = new Redis({ lazyConnect: true, autoResendUnfulfilledCommands: false })
      await redis.set('replay-no-resend', 'value')
      await assertSpans('SET replay-no-resend value')
    })

    it('bypasses bookkeeping with empty queues when resending unfulfilled commands is disabled', async () => {
      redis = new Redis({ lazyConnect: true, autoResendUnfulfilledCommands: false })
      await redis.connect()
      await sendWithoutBookkeeping(redis, new Redis.Command('get', ['replay-empty']))
      await assertSpans('GET replay-empty')
    })

    it('does not trace a queue drained while the plugin is disabled', async () => {
      tracer.use('ioredis', { enabled: false })
      redis = new Redis({ lazyConnect: true })
      await redis.set('replay-disabled-queue', 'value')
      tracer.use('ioredis', { enabled: true })
      await assertSpans('GET replay-marker')
      assert.equal(spans.filter(span => span.meta['redis.raw_command'] === 'SET replay-disabled-queue value').length, 0)
    })

    it('does not retrospectively trace commands enqueued before plugin activation', async () => {
      tracer.use('ioredis', { enabled: false })
      redis = new Redis({ lazyConnect: true })
      const queued = redis.set('replay-before-activation', 'value')
      tracer.use('ioredis', { enabled: true })
      await Promise.all([queued, once(redis, 'ready')])
      await sendWithoutBookkeeping(redis, new Redis.Command('get', ['replay-activation-marker']))
      await agent.assertSomeTraces(() => {
        assert.equal(spans.filter(span =>
          span.meta['redis.raw_command'] === 'SET replay-before-activation value').length, 0)
        assert.ok(spans.some(span => span.meta['redis.raw_command'] === 'GET replay-activation-marker'))
      })
    })

    for (const ready of [false, true]) {
      it(`preserves unhandled rejections after activation, ready=${ready}`, () => {
        const script = `
          const net = require('node:net')
          const tracer = require(${JSON.stringify(require.resolve('../../dd-trace'))}).init({
            plugins: false, startupLogs: false, telemetry: false, remoteConfig: false, flushInterval: 0,
          })
          tracer.use('ioredis', { enabled: false })
          const Redis = require(${JSON.stringify(require.resolve(`../../../versions/ioredis@${version}`))}).get()
          const Parser = require(${JSON.stringify(require.resolve('../../../versions/ioredis@5'))}).get('redis-parser')
          process.once('unhandledRejection', error => console.log(error.message))
          const server = net.createServer(socket => {
            if (!${ready}) return socket.destroy()
            const parser = new Parser({
              returnReply: args => socket.write(args[1]?.toString() === 'replay-rejection'
                ? '-ERR replay rejected\\r\\n' : '+OK\\r\\n'),
              returnError: error => { throw error },
            })
            socket.on('data', data => parser.execute(data))
          })
          server.listen(0, '127.0.0.1', () => {
            const client = new Redis({
              host: '127.0.0.1', port: server.address().port, lazyConnect: true,
              retryStrategy: null, enableReadyCheck: ${!ready}, disableClientInfo: true,
            })
            client.on('error', () => {})
            client.once('end', () => server.close())
            function send () {
              client.get('replay-rejection')
              tracer.use('ioredis', { enabled: true })
              if (${ready}) client.get('replay-marker').then(() => client.disconnect())
            }
            if (${ready}) {
              client.once('ready', send)
              client.connect().catch(error => { throw error })
            } else {
              send()
            }
          })
        `
        const child = spawnSync(process.execPath, ['--eval', script], {
          encoding: 'utf8', timeout: 10000,
        })
        assert.equal(child.stdout.trim(), ready ? 'ERR replay rejected' : 'Connection is closed.')
        assert.equal(child.status, 0, child.stderr)
      })
    }

    it('bypasses resend bookkeeping when tracing is disabled', async () => {
      redis = new Redis()
      await redis.set('replay-disabled', 'value')
      tracer.use('ioredis', { enabled: false })
      await assert.rejects(redis.incr('replay-disabled'), { message: /not an integer/ })
      tracer.use('ioredis', { enabled: true })
      await redis.get('replay-marker')
      await agent.assertSomeTraces(() => {
        assert.ok(spans.some(span => span.meta['redis.raw_command'] === 'GET replay-marker'))
      })
      assert.equal(spans.filter(span => span.meta['redis.raw_command'] === 'INCR replay-disabled').length, 0)
    })

    it('traces new commands sent by reconnectOnError independently of the resend', async () => {
      let retried = false
      let nested
      redis = new Redis({
        reconnectOnError: () => {
          if (retried) return false
          retried = true
          nested = redis.get('replay-nested')
          return 2
        },
      })
      await redis.set('replay-invalid-number', 'value')
      await assert.rejects(redis.incr('replay-invalid-number'), { message: /not an integer/ })
      await nested
      await assertSpans('INCR replay-invalid-number')
      await assertSpans('GET replay-nested')
    })

    const retries = ['TRYAGAIN retry later', 'CLUSTERDOWN retry later', 'MOVED', 'CONNECTION_CLOSED']
    const retryCases = retries.flatMap(error => error === 'CONNECTION_CLOSED'
      ? [[error, false, 1]]
      : [[error, false, 1], ...(error.startsWith('CLUSTERDOWN') ? [] : [[error, true, 0]]), [error, true, 1]])
    for (const [error, pipeline, delay] of retryCases) {
      const kind = pipeline ? 'pipeline command' : 'command'
      it(`traces each native promise for a Cluster ${kind} after ${error.split(' ')[0]}, delay=${delay}`, async () => {
        let attempts = 0
        await withServer(Parser, (args, port, socket) => {
          const name = args[0].toString().toLowerCase()
          if (name === 'get' && ['replay-cluster', 'replay-untraced'].includes(args[1].toString())) {
            attempts++
            if (error === 'CONNECTION_CLOSED' && attempts === 1) {
              socket.destroy()
              return
            }
            const reply = error === 'MOVED' ? `MOVED 0 127.0.0.1:${port}` : error
            return attempts === 1 ? `-${reply}\r\n` : '$5\r\nvalue\r\n'
          }
          return '+OK\r\n'
        }, async port => {
          redis = new Redis.Cluster([{ host: '127.0.0.1', port }], {
            enableReadyCheck: false,
            retryDelayOnTryAgain: delay,
            retryDelayOnClusterDown: delay,
            retryDelayOnMoved: delay,
            retryDelayOnFailover: delay,
            redisOptions: { enableReadyCheck: false, disableClientInfo: true },
          })
          if (pipeline || !error.startsWith('TRYAGAIN')) await once(redis, 'ready')
          assert.equal(await getClusterValue(redis, 'replay-cluster', pipeline), 'value')
          assert.equal(attempts, 2)
          await assertSpans('GET replay-cluster', pipeline ? 2 : 1)
          assert.deepEqual(spans.filter(span => span.meta['redis.raw_command'] === 'GET replay-cluster')
            .map(span => span.error).sort(), pipeline ? [0, 1] : [0])
          if (pipeline) {
            await assertSpans('GET {replay-cluster}-sibling', 2)
            assert.ok(spans.filter(span => span.meta['redis.raw_command'] === 'GET {replay-cluster}-sibling')
              .every(span => span.error === 0))
          }
          if (error.startsWith('TRYAGAIN') || error === 'CONNECTION_CLOSED') {
            tracer.use('ioredis', { enabled: false })
            attempts = 0
            assert.equal(await getClusterValue(redis, 'replay-untraced', pipeline), 'value')
            assert.equal(attempts, 2)
            tracer.use('ioredis', { enabled: true })
            await assertSpans('GET replay-cluster', pipeline ? 2 : 1)
            assert.equal(spans.filter(span => span.meta['redis.raw_command'] === 'GET replay-untraced').length, 0)
          }
          redis.disconnect()
        })
      })
    }

    it('does no command bookkeeping while another client waits for a delayed Cluster retry', async () => {
      let attempts = 0
      let observed
      const failed = new Promise(resolve => { observed = resolve })
      await withServer(Parser, args => {
        if (args[0].toString().toLowerCase() === 'get' && args[1].toString() === 'replay-delayed') {
          return ++attempts === 1 ? '-TRYAGAIN retry later\r\n' : '$5\r\nvalue\r\n'
        }
        return '+OK\r\n'
      }, async port => {
        redis = new Redis.Cluster([{ host: '127.0.0.1', port }], {
          enableReadyCheck: false,
          retryDelayOnTryAgain: 1,
          redisOptions: { enableReadyCheck: false, disableClientInfo: true, reconnectOnError: () => observed() },
        })
        other = new Redis()
        await Promise.all([once(redis, 'ready'), once(other, 'ready')])
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        try {
          async function sendWhileWaiting () {
            await failed
            assert.equal(attempts, 1)
            await sendWithoutBookkeeping(other, new Redis.Command('get', ['replay-during-retry']))
            await clock.tickAsync(1)
          }
          const [value] = await Promise.all([redis.get('replay-delayed'), sendWhileWaiting()])
          assert.equal(value, 'value')
          assert.equal(attempts, 2)
        } finally {
          clock.restore()
        }
        await assertSpans('GET replay-delayed')
        await assertSpans('GET replay-during-retry')
      })
    })

    for (const failure of [false, true]) {
      for (const disabled of [false, true]) {
        const outcome = failure ? 'rejection' : 'success'
        it(`does not mark new commands after ${outcome}, disabled=${disabled}`, async () => {
          redis = new Redis({ lazyConnect: true })
          const ready = once(redis, 'ready')
          const command = new Redis.Command('get', failure ? [] : ['replay-cleanup'])
          const pending = redis.sendCommand(command)
          async function disableAfterReady () {
            await ready
            if (disabled) tracer.use('ioredis', { enabled: false })
          }
          await Promise.all([
            disableAfterReady(),
            failure ? assert.rejects(pending, { message: /wrong number of arguments/ }) : pending,
          ])
          tracer.use('ioredis', { enabled: true })
          await sendWithoutBookkeeping(redis, new Redis.Command('get', ['replay-after-cleanup']))
          await assertSpans('GET replay-after-cleanup')
        })
      }
    }

    it('deduplicates a managed HIMPORT command through preparation and recovery', async function () {
      if (semver.lt(resolvedVersion, '6.0.0')) this.skip()
      let attempts = 0
      await withServer(Parser, args => {
        if (args[0].toString().toLowerCase() === 'reset') return '+RESET\r\n'
        if (args[0].toString().toLowerCase() === 'himport' && args[1].toString().toLowerCase() === 'set') {
          attempts++
          return attempts === 1 ? '-ERR no such fieldset\r\n' : ':1\r\n'
        }
        return '+OK\r\n'
      }, async port => {
        redis = new Redis({
          host: '127.0.0.1',
          port,
          enableReadyCheck: false,
          disableClientInfo: true,
          himportFieldsets: [{ name: 'review', fields: ['field'] }],
        })
        await once(redis, 'ready')
        await redis.call('reset')
        assert.equal(await redis.call('himport', 'SET', 'review-key', 'review', 'value'), 1)
        assert.equal(attempts, 2)
        await assertSpans('HIMPORT SET review-key review value')
        assert.ok(spans.some(span => span.meta['redis.raw_command'] === 'HIMPORT PREPARE review field'))
        tracer.use('ioredis', { enabled: false })
        assert.equal(await redis.call('himport', 'SET', 'untraced-key', 'review', 'value'), 1)
        tracer.use('ioredis', { enabled: true })
        await assertSpans('HIMPORT SET review-key review value')
        assert.equal(spans.filter(span => span.meta['redis.raw_command'] ===
          'HIMPORT SET untraced-key review value').length, 0)
        redis.disconnect()
      })
    })

    for (const cluster of [false, true]) {
      it(`traces a managed HIMPORT ${cluster ? 'Cluster ' : ''}pipeline after preparation`, async function () {
        if (semver.lt(resolvedVersion, '6.0.0')) this.skip()
        let preparations = 0
        await withServer(Parser, args => {
          if (args[0].toString().toLowerCase() === 'reset') return '+RESET\r\n'
          if (args[1]?.toString().toLowerCase() === 'prepare') preparations++
          return args[0].toString().toLowerCase() === 'himport' && args[1].toString().toLowerCase() === 'set'
            ? ':1\r\n'
            : '+OK\r\n'
        }, async port => {
          const options = {
            enableReadyCheck: false,
            disableClientInfo: true,
            himportFieldsets: [{ name: 'review', fields: ['field'] }],
          }
          redis = cluster
            ? new Redis.Cluster([{ host: '127.0.0.1', port }], {
              ...options,
              redisOptions: { enableReadyCheck: false, disableClientInfo: true },
            })
            : new Redis({ ...options, host: '127.0.0.1', port })
          await once(redis, 'ready')
          await redis.call('reset')
          const prepared = preparations
          const pipeline = redis.pipeline()
          pipeline.call('himport', 'SET', 'replay-pipeline', 'review', 'value')
          const results = await pipeline.exec()
          assert.deepEqual(results, [[null, 1]])
          assert.equal(preparations, prepared + 1)
          await assertSpans('HIMPORT SET replay-pipeline review value')
          await assertSpans('HIMPORT PREPARE review field', preparations)
        })
      })
    }

    it('traces each native HIMPORT control command sent to a Cluster master', async function () {
      if (semver.lt(resolvedVersion, '6.0.0')) this.skip()
      await withServer(Parser, () => '+OK\r\n', async port => {
        redis = new Redis.Cluster([{ host: '127.0.0.1', port }], {
          enableReadyCheck: false,
          redisOptions: { enableReadyCheck: false, disableClientInfo: true },
        })
        await once(redis, 'ready')
        for (const args of [['PREPARE', 'review', 'field'], ['DISCARD', 'review'], ['DISCARDALL']]) {
          assert.equal(await redis.call('himport', ...args), 'OK')
          await assertSpans(`HIMPORT ${args.join(' ')}`)
        }
      })
    })

    it('deduplicates a managed HIMPORT command after an asynchronous ASK preparation', async function () {
      if (semver.lt(resolvedVersion, '6.0.0')) this.skip()
      let attempts = 0
      await withServer(Parser, (args, port) => {
        if (args[0].toString().toLowerCase() === 'himport' && args[1].toString().toLowerCase() === 'set') {
          return ++attempts === 1 ? `-ASK 0 127.0.0.1:${port}\r\n` : ':1\r\n'
        }
        return '+OK\r\n'
      }, async port => {
        redis = new Redis.Cluster([{ host: '127.0.0.1', port }], {
          enableReadyCheck: false,
          himportFieldsets: [{ name: 'review', fields: ['field'] }],
          redisOptions: { enableReadyCheck: false, disableClientInfo: true },
        })
        await once(redis, 'ready')
        assert.equal(await redis.call('himport', 'SET', 'replay-himport-ask', 'review', 'value'), 1)
        assert.equal(attempts, 2)
        await assertSpans('HIMPORT SET replay-himport-ask review value')
        assert.ok(spans.some(span => span.meta['redis.raw_command'] === 'ASKING'))
      })
    })
  })
})

/**
 * @param {import('ioredis').Cluster} client
 * @param {string} key
 * @param {boolean} pipeline
 */
async function getClusterValue (client, key, pipeline) {
  if (!pipeline) return client.get(key)
  const [[error, value], sibling] = await client.pipeline().get(key).get(`{${key}}-sibling`).exec()
  assert.equal(error, null)
  assert.deepEqual(sibling, [null, 'OK'])
  return value
}

/**
 * @param {typeof import('redis-parser')} Parser
 * @param {(args: Buffer[], port: number, socket: import('node:net').Socket) => string | undefined} reply
 * @param {(port: number) => Promise<void>} run
 */
async function withServer (Parser, reply, run) {
  const sockets = new Set()
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    const parser = new Parser({
      returnReply: args => {
        const port = server.address().port
        const response = args[0].toString().toLowerCase() === 'cluster'
          ? `*1\r\n*3\r\n:0\r\n:16383\r\n*3\r\n$9\r\n127.0.0.1\r\n:${port}\r\n$4\r\nnode\r\n`
          : reply(args, port, socket)
        if (response !== undefined) socket.write(response)
      },
      returnError (error) { throw error },
    })
    socket.on('data', data => parser.execute(data))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    await run(server.address().port)
  } finally {
    for (const socket of sockets) socket.destroy()
    const closed = once(server, 'close')
    server.close()
    await closed
  }
}
