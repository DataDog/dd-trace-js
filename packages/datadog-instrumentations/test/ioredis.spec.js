'use strict'

const assert = require('node:assert')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

const { channel } = require('../src/helpers/instrument')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

describe('ioredis instrumentation', () => {
  withVersions('ioredis', 'ioredis', (version) => {
    let Redis
    let startCh, finishCh, errorCh
    let startStub, finishStub, errorStub

    before(() => agent.load(['ioredis']))

    beforeEach(() => {
      startCh = channel('apm:ioredis:command:start')
      finishCh = channel('apm:ioredis:command:finish')
      errorCh = channel('apm:ioredis:command:error')

      startStub = sinon.stub()
      finishStub = sinon.stub()
      errorStub = sinon.stub()

      startCh.subscribe(startStub)
      finishCh.subscribe(finishStub)
      errorCh.subscribe(errorStub)

      const ioredisRequire = require(`../../../versions/ioredis@${version}`)
      Redis = ioredisRequire.get()
    })

    afterEach(() => {
      startCh.unsubscribe(startStub)
      finishCh.unsubscribe(finishStub)
      errorCh.unsubscribe(errorStub)
    })

    function getCtxByCommand (stub, commandName) {
      for (const call of stub.args) {
        const ctx = call[0]
        if (ctx && ctx.command === commandName) return ctx
      }
      return null
    }

    describe('Cluster', () => {
      it('publishes start with context from redisOptions when using Cluster', async function () {
        if (!Redis.Cluster) this.skip()

        const Cluster = Redis.Cluster
        const cluster = new Cluster(
          [{ host: '127.0.0.1', port: 7000 }],
          {
            lazyConnect: true,
            redisOptions: {
              connectionName: 'cluster-test',
              db: 2,
              host: '127.0.0.1',
              port: 7000
            }
          }
        )

        try {
          await cluster.get('foo')
        } catch (e) {
          // ignore connection errors; we only assert that instrumentation ran
        }

        sinon.assert.called(startStub)
        const ctx = getCtxByCommand(startStub, 'get')
        assert(ctx !== null)
        assert.strictEqual(ctx.command, 'get')
        assert.deepEqual(ctx.args, ['foo'])
        assert.strictEqual(ctx.connectionName, 'cluster-test')
        assert.strictEqual(ctx.db, 2)
        assert.deepEqual(ctx.connectionOptions, { host: '127.0.0.1', port: 7000 })
      })

      it('falls back to startupNodes for host/port when not provided in redisOptions', async function () {
        if (!Redis.Cluster) this.skip()

        const Cluster = Redis.Cluster
        const cluster = new Cluster(
          [{ host: '127.0.0.1', port: 7001 }],
          {
            lazyConnect: true,
            redisOptions: {
              connectionName: 'cluster-test2',
              db: 3
            }
          }
        )

        try {
          await cluster.get('bar')
        } catch (e) {
          // ignore connection errors; we only assert that instrumentation ran
        }

        sinon.assert.called(startStub)
        const ctx = getCtxByCommand(startStub, 'get')
        assert(ctx !== null)
        assert.strictEqual(ctx.connectionName, 'cluster-test2')
        assert.strictEqual(ctx.db, 3)
        assert.deepEqual(ctx.connectionOptions, { host: '127.0.0.1', port: 7001 })
      })
    })
  })
})
