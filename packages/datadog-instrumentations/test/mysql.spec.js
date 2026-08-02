'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const net = require('node:net')

const { afterEach, before, describe, it } = require('mocha')
const sinon = require('sinon')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { channel } = require('../src/helpers/instrument')

describe('mysql instrumentation', () => {
  withVersions('mysql', 'mysql', (version) => {
    const config = {
      host: '127.0.0.1',
      user: 'root',
      database: 'db',
    }

    const sql = 'SELECT 1'
    let mysql, acquireStartCh, acquireFinishCh, acquireStart, acquireFinish

    before(() => agent.load(['mysql']))

    before(() => {
      mysql = require(`../../../versions/mysql@${version}`).get()
      acquireStartCh = channel('apm:mysql:pool:acquire:start')
      acquireFinishCh = channel('apm:mysql:pool:acquire:finish')
    })

    afterEach(() => {
      if (acquireStart !== undefined) {
        acquireStartCh.unsubscribe(acquireStart)
        acquireStart = undefined
      }
      if (acquireFinish !== undefined) {
        acquireFinishCh.unsubscribe(acquireFinish)
        acquireFinish = undefined
      }
    })

    describe('lib/Pool.js', () => {
      it('dispatches getConnection before query returns', async () => {
        const pool = mysql.createPool(config)
        const getConnection = pool.getConnection
        let queryReturned = false
        let acquireDispatchedBeforeReturn = false

        /**
         * @param {...unknown} args
         * @returns {unknown}
         */
        pool.getConnection = function (...args) {
          if (!queryReturned) acquireDispatchedBeforeReturn = true
          return getConnection.apply(this, args)
        }

        try {
          const query = new Promise((resolve, reject) => {
            pool.query(sql, error => error ? reject(error) : resolve())
          })
          queryReturned = true

          await query

          assert.strictEqual(acquireDispatchedBeforeReturn, true)
        } finally {
          pool.getConnection = getConnection
          await new Promise(resolve => pool.end(resolve))
        }
      })

      it('treats an acquire reentered from enqueue as explicit', async function () {
        const pool = mysql.createPool({ ...config, connectionLimit: 1 })
        const heldConnection = await new Promise((resolve, reject) => {
          pool.getConnection((error, connection) => error ? reject(error) : resolve(connection))
        })
        if (typeof pool._enqueueCallback !== 'function') {
          heldConnection.release()
          await new Promise(resolve => pool.end(resolve))
          return this.skip()
        }
        acquireStart = sinon.stub()
        acquireStartCh.subscribe(acquireStart)
        let explicitAcquire

        pool.once('enqueue', () => {
          explicitAcquire = new Promise((resolve, reject) => {
            pool.getConnection((error, connection) => {
              if (error) return reject(error)
              connection.release()
              resolve()
            })
          })
        })

        try {
          const query = new Promise((resolve, reject) => {
            pool.query(sql, error => error ? reject(error) : resolve())
          })
          heldConnection.release()

          await Promise.all([query, explicitAcquire])
          sinon.assert.calledOnce(acquireStart)
        } finally {
          await new Promise(resolve => pool.end(resolve))
        }
      })
    })

    describe('pool cluster acquisition', () => {
      it('emits one acquire lifecycle per physical failover attempt', async () => {
        acquireStart = sinon.stub()
        acquireFinish = sinon.stub()
        acquireStartCh.subscribe(acquireStart)
        acquireFinishCh.subscribe(acquireFinish)

        const probe = net.createServer()
        probe.listen(0, '127.0.0.1')
        await once(probe, 'listening')
        const deadPort = probe.address().port
        await new Promise(resolve => probe.close(resolve))

        const cluster = mysql.createPoolCluster()
        cluster.add('dead', { ...config, port: deadPort, connectionLimit: 1, connectTimeout: 500 })
        cluster.add('live', { ...config, connectionLimit: 1 })
        cluster.on('warn', () => {})

        try {
          const connection = await new Promise((resolve, reject) => {
            cluster.of('*').getConnection((error, connection) => error ? reject(error) : resolve(connection))
          })
          connection.release()

          sinon.assert.callCount(acquireStart, 2)
          sinon.assert.callCount(acquireFinish, 2)
          assert.ok(acquireFinish.firstCall.args[0].error)
          assert.strictEqual(acquireFinish.secondCall.args[0].error, null)
        } finally {
          if (cluster.end.length === 0) {
            cluster.end()
          } else {
            await new Promise(resolve => cluster.end(resolve))
          }
        }
      })
    })
  })
})
