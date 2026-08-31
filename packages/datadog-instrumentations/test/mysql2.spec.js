'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const net = require('node:net')

const { afterEach, before, beforeEach, describe, it } = require('mocha')
const semver = require('semver')
const sinon = require('sinon')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { channel } = require('../src/helpers/instrument')
describe('mysql2 instrumentation', () => {
  withVersions('mysql2', 'mysql2', (version) => {
    function abort ({ sql, abortController }) {
      assert.strictEqual(typeof sql, 'string')
      const error = new Error('Test')
      abortController.abort(error)
    }

    function noop () {}

    const config = {
      host: '127.0.0.1',
      user: 'root',
      database: 'db',
    }

    const sql = 'SELECT 1'
    let startCh, mysql2, shouldEmitEndAfterQueryAbort, poolAddsErrorListenerOnQuery
    let apmQueryStartChannel, apmQueryStart, mysql2Version

    before(() => {
      startCh = channel('datadog:mysql2:outerquery:start')
      return agent.load(['mysql2'])
    })

    before(() => {
      const mysql2Require = require(`../../../versions/mysql2@${version}`)
      mysql2Version = mysql2Require.version()
      // in v1.3.3 CommandQuery started to emit 'end' after 'error' event
      shouldEmitEndAfterQueryAbort = semver.intersects(mysql2Version, '>=1.3.3')
      // in v3.17.2 Pool.query adds a once('error') listener for isReadOnlyError handling
      poolAddsErrorListenerOnQuery = semver.intersects(mysql2Version, '>=3.17.2')
      mysql2 = mysql2Require.get()
      apmQueryStartChannel = channel('apm:mysql2:query:start')
    })

    beforeEach(() => {
      apmQueryStart = sinon.stub()
      apmQueryStartChannel.subscribe(apmQueryStart)
    })

    afterEach(() => {
      if (startCh?.hasSubscribers) {
        startCh.unsubscribe(abort)
        startCh.unsubscribe(noop)
      }
      apmQueryStartChannel.unsubscribe(apmQueryStart)
    })

    describe('lib/connection.js', () => {
      let connection

      beforeEach(() => {
        connection = mysql2.createConnection(config)

        connection.connect()
      })

      afterEach((done) => {
        connection.end(() => done())
      })

      describe('Connection.prototype.query', () => {
        describe('with string as query', () => {
          describe('with callback', () => {
            it('should abort the query on abortController.abort()', (done) => {
              startCh.subscribe(abort)
              const query = connection.query(sql, (err) => {
                assert.strictEqual(err.message, 'Test')
                sinon.assert.notCalled(apmQueryStart)

                if (!shouldEmitEndAfterQueryAbort) done()
              })

              query.on('end', () => done())
            })

            it('should work without abortController.abort()', (done) => {
              startCh.subscribe(noop)
              connection.query(sql, (err) => {
                assert.strictEqual(err, null)
                sinon.assert.called(apmQueryStart)

                done()
              })
            })

            it('should work without subscriptions', (done) => {
              connection.query(sql, (err) => {
                assert.strictEqual(err, null)
                sinon.assert.called(apmQueryStart)

                done()
              })
            })
          })

          describe('without callback', () => {
            it('should abort the query on abortController.abort()', (done) => {
              startCh.subscribe(abort)

              const query = connection.query(sql)

              query.on('error', (err) => {
                assert.strictEqual(err.message, 'Test')
                sinon.assert.notCalled(apmQueryStart)
                if (!shouldEmitEndAfterQueryAbort) done()
              })

              query.on('end', () => done())
            })

            it('should work without abortController.abort()', (done) => {
              startCh.subscribe(noop)

              const query = connection.query(sql)

              query.on('error', (err) => done(err))
              query.on('end', () => {
                sinon.assert.called(apmQueryStart)

                done()
              })
            })

            it('should work without subscriptions', (done) => {
              const query = connection.query(sql)

              query.on('error', (err) => done(err))
              query.on('end', () => {
                sinon.assert.called(apmQueryStart)

                done()
              })
            })
          })
        })

        describe('with object as query', () => {
          describe('with callback', () => {
            it('should abort the query on abortController.abort()', (done) => {
              startCh.subscribe(abort)
              const query = mysql2.Connection.createQuery(sql, (err) => {
                assert.strictEqual(err.message, 'Test')
                sinon.assert.notCalled(apmQueryStart)

                if (!shouldEmitEndAfterQueryAbort) done()
              }, null, {})
              connection.query(query)

              query.on('end', () => done())
            })

            it('should work without abortController.abort()', (done) => {
              startCh.subscribe(noop)

              const query = mysql2.Connection.createQuery(sql, (err) => {
                assert.strictEqual(err, null)
                sinon.assert.called(apmQueryStart)

                done()
              }, null, {})

              connection.query(query)
            })

            it('should work without subscriptions', (done) => {
              const query = mysql2.Connection.createQuery(sql, (err) => {
                assert.strictEqual(err, null)
                sinon.assert.called(apmQueryStart)

                done()
              }, null, {})

              connection.query(query)
            })
          })

          describe('without callback', () => {
            it('should abort the query on abortController.abort()', (done) => {
              startCh.subscribe(abort)

              const query = mysql2.Connection.createQuery(sql, null, null, {})
              query.on('error', (err) => {
                assert.strictEqual(err.message, 'Test')
                sinon.assert.notCalled(apmQueryStart)

                if (!shouldEmitEndAfterQueryAbort) done()
              })

              connection.query(query)

              query.on('end', () => done())
            })

            it('should work without abortController.abort()', (done) => {
              startCh.subscribe(noop)

              const query = mysql2.Connection.createQuery(sql, null, null, {})
              query.on('error', (err) => done(err))
              query.on('end', () => {
                sinon.assert.called(apmQueryStart)

                done()
              })

              connection.query(query)
            })

            it('should work without subscriptions', (done) => {
              const query = mysql2.Connection.createQuery(sql, null, null, {})
              query.on('error', (err) => done(err))
              query.on('end', () => {
                sinon.assert.called(apmQueryStart)

                done()
              })

              connection.query(query)
            })
          })
        })
      })

      describe('Connection.prototype.execute', () => {
        describe('with the query in options', () => {
          it('should abort the query on abortController.abort()', (done) => {
            startCh.subscribe(abort)

            const options = { sql }
            const commandExecute = connection.execute(options, (err) => {
              assert.strictEqual(err.message, 'Test')
              sinon.assert.notCalled(apmQueryStart)

              done()
            })

            assert.strictEqual(commandExecute.sql, options.sql)
          })

          it('should work without abortController.abort()', (done) => {
            startCh.subscribe(noop)

            const options = { sql }

            connection.execute(options, (err) => {
              assert.strictEqual(err, null)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })

          it('should work without subscriptions', (done) => {
            const options = { sql }

            connection.execute(options, (err) => {
              assert.strictEqual(err, null)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })
        })

        describe('with sql as string', () => {
          it('should wrap onResult once for Prepare commands', (done) => {
            const paramCount = 50
            const placeholders = Array.from({ length: paramCount }, () => '?').join(', ')
            const values = Array.from({ length: paramCount }, (_, index) => index)
            const addCommand = connection.addCommand
            let prepareCommand
            let onResultSetCount = 0
            let wrappedAtAddCommand = false

            connection.addCommand = function (cmd) {
              if (cmd?.constructor?.name === 'Prepare') {
                prepareCommand = cmd

                let currentOnResult = cmd.onResult
                const originalOnResult = currentOnResult
                Object.defineProperty(cmd, 'onResult', {
                  configurable: true,
                  enumerable: true,
                  get () { return currentOnResult },
                  set (value) {
                    if (value !== currentOnResult) {
                      onResultSetCount++
                    }
                    currentOnResult = value
                  },
                })

                const result = addCommand.apply(this, arguments)
                wrappedAtAddCommand = onResultSetCount === 1 && prepareCommand.onResult !== originalOnResult
                return result
              }

              return addCommand.apply(this, arguments)
            }

            connection.execute(`SELECT ${placeholders}`, values, (err) => {
              assert.strictEqual(err, null)
              assert.ok(prepareCommand)
              assert.strictEqual(prepareCommand.parameterCount, paramCount)
              assert.strictEqual(prepareCommand.parameterDefinitions.length, paramCount)
              assert.strictEqual(wrappedAtAddCommand, true)
              assert.strictEqual(onResultSetCount, 1)
              done()
            })
          })

          it('should abort the query on abortController.abort()', (done) => {
            startCh.subscribe(abort)

            connection.execute(sql, (err) => {
              assert.strictEqual(err.message, 'Test')
              sinon.assert.notCalled(apmQueryStart)
              done()
            })
          })

          it('should work without abortController.abort()', (done) => {
            startCh.subscribe(noop)

            connection.execute(sql, (err) => {
              assert.strictEqual(err, null)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })

          it('should work without subscriptions', (done) => {
            const options = { sql }

            connection.execute(options, (err) => {
              assert.strictEqual(err, null)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })
        })
      })
    })

    describe('lib/pool.js', () => {
      let pool

      before(() => {
        pool = mysql2.createPool(config)
      })

      for (const method of ['query', 'execute']) {
        it(`dispatches getConnection before ${method} returns`, async () => {
          const getConnection = pool.getConnection
          let methodReturned = false
          let acquireDispatchedBeforeReturn = false

          /**
           * @param {...unknown} args
           * @returns {unknown}
           */
          pool.getConnection = function (...args) {
            if (!methodReturned) acquireDispatchedBeforeReturn = true
            return getConnection.apply(this, args)
          }

          try {
            const result = new Promise((resolve, reject) => {
              pool[method](sql, error => error ? reject(error) : resolve())
            })
            methodReturned = true
            await result

            assert.strictEqual(acquireDispatchedBeforeReturn, true)
          } finally {
            pool.getConnection = getConnection
          }
        })
      }

      it('finishes callback and promise acquires when the stream factory throws synchronously', async () => {
        const failure = new Error('stream factory failed')
        const connectionStartCh = channel('apm:mysql2:connection:start')
        const acquireStartCh = channel('apm:mysql2:pool:acquire:start')
        const acquireFinishCh = channel('apm:mysql2:pool:acquire:finish')
        const acquireStart = sinon.stub()
        const acquireFinish = sinon.stub()
        const throwingPool = mysql2.createPool({
          ...config,
          stream: () => { throw failure },
        })
        connectionStartCh.subscribe(noop)
        acquireStartCh.subscribe(acquireStart)
        acquireFinishCh.subscribe(acquireFinish)

        try {
          assert.throws(() => throwingPool.getConnection(noop), failure)

          if (typeof throwingPool.promise === 'function') {
            await assert.rejects(throwingPool.promise().getConnection(), failure)
          }

          const expectedAcquires = typeof throwingPool.promise === 'function' ? 2 : 1
          sinon.assert.callCount(acquireStart, expectedAcquires)
          sinon.assert.callCount(acquireFinish, expectedAcquires)
          for (const call of acquireFinish.getCalls()) assert.strictEqual(call.args[0].error, failure)
        } finally {
          connectionStartCh.unsubscribe(noop)
          acquireStartCh.unsubscribe(acquireStart)
          acquireFinishCh.unsubscribe(acquireFinish)
          await new Promise(resolve => throwingPool.end(resolve))
        }
      })

      describe('Pool.prototype.query', () => {
        it('does not transfer an aborted query wait to the next connection user', async function () {
          if (!semver.satisfies(mysql2Version, '>=3.11.5')) return this.skip()

          startCh.subscribe(abort)
          try {
            const abortedQuery = pool.query(sql)
            abortedQuery.once('error', noop)
            await new Promise(resolve => abortedQuery.once('end', resolve))
          } finally {
            startCh.unsubscribe(abort)
          }

          const connection = await new Promise((resolve, reject) => {
            pool.getConnection((error, connection) => error ? reject(error) : resolve(connection))
          })
          const directQuery = connection.query(sql)
          await once(directQuery, 'end')
          connection.release()

          assert.strictEqual(apmQueryStart.lastCall.args[0].poolWaitTime, undefined)
        })

        it('treats an acquire reentered from enqueue as explicit', async () => {
          const acquireStartCh = channel('apm:mysql2:pool:acquire:start')
          const acquireStart = sinon.stub()

          const reentrantPool = mysql2.createPool({ ...config, connectionLimit: 1 })
          const heldConnection = await new Promise((resolve, reject) => {
            reentrantPool.getConnection((error, connection) => error ? reject(error) : resolve(connection))
          })
          acquireStartCh.subscribe(acquireStart)
          let explicitAcquire

          reentrantPool.once('enqueue', () => {
            explicitAcquire = new Promise((resolve, reject) => {
              reentrantPool.getConnection((error, connection) => {
                if (error) return reject(error)
                connection.release()
                resolve()
              })
            })
          })

          try {
            const query = new Promise((resolve, reject) => {
              reentrantPool.query(sql, error => error ? reject(error) : resolve())
            })
            heldConnection.release()

            await Promise.all([query, explicitAcquire])
            sinon.assert.calledOnce(acquireStart)
          } finally {
            acquireStartCh.unsubscribe(acquireStart)
            await new Promise(resolve => reentrantPool.end(resolve))
          }
        })

        describe('with object as query', () => {
          describe('with callback', () => {
            it('should abort the query on abortController.abort()', (done) => {
              startCh.subscribe(abort)
              const query = pool.query({ sql }, (err) => {
                assert.strictEqual(err.message, 'Test')
                sinon.assert.notCalled(apmQueryStart)

                if (!shouldEmitEndAfterQueryAbort) done()
              })

              query.on('end', () => done())
            })

            it('should work without abortController.abort()', (done) => {
              startCh.subscribe(noop)

              pool.query({ sql }, (err) => {
                assert.strictEqual(err, null)
                sinon.assert.called(apmQueryStart)

                done()
              })
            })

            it('should work without subscriptions', (done) => {
              pool.query({ sql }, (err) => {
                assert.strictEqual(err, null)
                sinon.assert.called(apmQueryStart)

                done()
              })
            })
          })

          describe('without callback', () => {
            it('should abort the query on abortController.abort()', (done) => {
              startCh.subscribe(abort)
              const query = pool.query({ sql })
              query.on('error', err => {
                assert.strictEqual(err.message, 'Test')
                sinon.assert.notCalled(apmQueryStart)
                if (!shouldEmitEndAfterQueryAbort) done()
              })

              query.on('end', () => done())
            })

            it('should work without abortController.abort()', (done) => {
              startCh.subscribe(noop)
              const query = pool.query({ sql })

              query.on('error', err => done(err))
              query.on('end', () => {
                sinon.assert.called(apmQueryStart)

                done()
              })
            })

            it('should work without subscriptions', (done) => {
              pool.query({ sql }, (err) => {
                assert.strictEqual(err, null)
                sinon.assert.called(apmQueryStart)

                done()
              })
            })
          })
        })

        describe('with string as query', () => {
          describe('with callback', () => {
            it('should abort the query on abortController.abort()', (done) => {
              startCh.subscribe(abort)
              const query = pool.query(sql, (err) => {
                assert.strictEqual(err.message, 'Test')
                sinon.assert.notCalled(apmQueryStart)

                if (!shouldEmitEndAfterQueryAbort) done()
              })

              query.on('end', () => done())
            })

            it('should work without abortController.abort()', (done) => {
              startCh.subscribe(noop)

              pool.query(sql, (err) => {
                assert.strictEqual(err, null)
                sinon.assert.called(apmQueryStart)

                done()
              })
            })

            it('should work without subscriptions', (done) => {
              pool.query(sql, (err) => {
                assert.strictEqual(err, null)
                sinon.assert.called(apmQueryStart)

                done()
              })
            })
          })

          describe('without callback', () => {
            it('should abort the query on abortController.abort()', (done) => {
              startCh.subscribe(abort)
              const query = pool.query(sql)
              query.on('error', err => {
                assert.strictEqual(err.message, 'Test')
                sinon.assert.notCalled(apmQueryStart)
                if (!shouldEmitEndAfterQueryAbort) done()
              })

              query.on('end', () => done())
            })

            it('should work without abortController.abort()', async () => {
              startCh.subscribe(noop)
              const query = pool.query(sql)

              assert.strictEqual(query.listenerCount('error'), 0)

              await once(query, 'end')

              assert.strictEqual(query.listenerCount('error'), poolAddsErrorListenerOnQuery ? 1 : 0)

              sinon.assert.called(apmQueryStart)
            })

            it('should work without subscriptions', (done) => {
              pool.query(sql, (err) => {
                assert.strictEqual(err, null)
                sinon.assert.called(apmQueryStart)

                done()
              })
            })
          })
        })
      })

      describe('Pool.prototype.execute', () => {
        describe('with object as query', () => {
          describe('with callback', () => {
            it('should abort the query on abortController.abort()', (done) => {
              startCh.subscribe(abort)
              pool.execute({ sql }, (err) => {
                assert.strictEqual(err.message, 'Test')

                setTimeout(() => {
                  sinon.assert.notCalled(apmQueryStart)
                  done()
                }, 100)
              })
            })

            it('should work without abortController.abort()', (done) => {
              startCh.subscribe(noop)

              pool.execute({ sql }, (err) => {
                assert.strictEqual(err, null)
                sinon.assert.called(apmQueryStart)

                done()
              })
            })

            it('should work without subscriptions', (done) => {
              pool.execute({ sql }, (err) => {
                assert.strictEqual(err, null)
                sinon.assert.called(apmQueryStart)

                done()
              })
            })
          })
        })

        describe('with string as query', () => {
          describe('with callback', () => {
            it('should abort the query on abortController.abort()', (done) => {
              startCh.subscribe(abort)
              pool.execute(sql, (err) => {
                assert.strictEqual(err.message, 'Test')

                setTimeout(() => {
                  sinon.assert.notCalled(apmQueryStart)
                  done()
                }, 100)
              })
            })

            it('should work without abortController.abort()', (done) => {
              startCh.subscribe(noop)

              pool.execute(sql, (err) => {
                assert.strictEqual(err, null)
                sinon.assert.called(apmQueryStart)

                done()
              })
            })

            it('should work without subscriptions', (done) => {
              pool.execute(sql, (err) => {
                assert.strictEqual(err, null)
                sinon.assert.called(apmQueryStart)

                done()
              })
            })
          })
        })
      })
    })

    describe('lib/pool_cluster.js', () => {
      let poolCluster, connection

      before(function () {
        if (!semver.satisfies(mysql2Version, '>=2.3.0')) this.skip()
        poolCluster = mysql2.createPoolCluster()
        poolCluster.add('clusterA', config)
      })

      beforeEach((done) => {
        poolCluster.getConnection('clusterA', function (err, _connection) {
          if (err) {
            done(err)
            return
          }

          connection = _connection

          done()
        })
      })

      afterEach(() => {
        connection?.release()
      })

      describe('PoolNamespace.prototype.query', () => {
        describe('with string as query', () => {
          it('should abort the query on abortController.abort()', (done) => {
            startCh.subscribe(abort)
            const namespace = poolCluster.of()
            namespace.query(sql, (err) => {
              assert.strictEqual(err.message, 'Test')

              setTimeout(() => {
                sinon.assert.notCalled(apmQueryStart)
                done()
              }, 100)
            })
          })

          it('should work without abortController.abort()', (done) => {
            startCh.subscribe(noop)

            const namespace = poolCluster.of()
            namespace.query(sql, (err) => {
              assert.strictEqual(err, null)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })

          it('should work without subscriptions', (done) => {
            const namespace = poolCluster.of()
            namespace.query(sql, (err) => {
              assert.strictEqual(err, null)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })
        })

        describe('with object as query', () => {
          it('should abort the query on abortController.abort()', (done) => {
            startCh.subscribe(abort)
            const namespace = poolCluster.of()
            namespace.query({ sql }, (err) => {
              assert.strictEqual(err.message, 'Test')

              setTimeout(() => {
                sinon.assert.notCalled(apmQueryStart)
                done()
              }, 100)
            })
          })

          it('should work without abortController.abort()', (done) => {
            startCh.subscribe(noop)

            const namespace = poolCluster.of()
            namespace.query({ sql }, (err) => {
              assert.strictEqual(err, null)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })

          it('should work without subscriptions', (done) => {
            const namespace = poolCluster.of()
            namespace.query({ sql }, (err) => {
              assert.strictEqual(err, null)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })
        })
      })

      describe('PoolNamespace.prototype.execute', () => {
        describe('with string as query', () => {
          it('should abort the query on abortController.abort()', (done) => {
            startCh.subscribe(abort)

            const namespace = poolCluster.of()
            namespace.execute(sql, (err) => {
              assert.strictEqual(err.message, 'Test')

              setTimeout(() => {
                sinon.assert.notCalled(apmQueryStart)
                done()
              }, 100)
            })
          })

          it('should work without abortController.abort()', (done) => {
            startCh.subscribe(noop)

            const namespace = poolCluster.of()
            namespace.execute(sql, (err) => {
              assert.strictEqual(err, null)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })

          it('should work without subscriptions', (done) => {
            const namespace = poolCluster.of()
            namespace.execute(sql, (err) => {
              assert.strictEqual(err, null)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })
        })

        describe('with object as query', () => {
          it('should abort the query on abortController.abort()', (done) => {
            startCh.subscribe(abort)

            const namespace = poolCluster.of()
            namespace.execute({ sql }, (err) => {
              assert.strictEqual(err.message, 'Test')

              setTimeout(() => {
                sinon.assert.notCalled(apmQueryStart)
                done()
              }, 100)
            })
          })

          it('should work without abortController.abort()', (done) => {
            startCh.subscribe(noop)

            const namespace = poolCluster.of()
            namespace.execute({ sql }, (err) => {
              assert.strictEqual(err, null)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })

          it('should work without subscriptions', (done) => {
            const namespace = poolCluster.of()
            namespace.execute({ sql }, (err) => {
              assert.strictEqual(err, null)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })
        })
      })

      describe('PoolNamespace.prototype.getConnection failover', () => {
        it('emits one acquire lifecycle per physical failover attempt', async () => {
          const acquireStartCh = channel('apm:mysql2:pool:acquire:start')
          const acquireFinishCh = channel('apm:mysql2:pool:acquire:finish')
          const acquireStart = sinon.stub()
          const acquireFinish = sinon.stub()
          acquireStartCh.subscribe(acquireStart)
          acquireFinishCh.subscribe(acquireFinish)

          const probe = net.createServer()
          probe.listen(0, '127.0.0.1')
          await once(probe, 'listening')
          const deadPort = probe.address().port
          await new Promise(resolve => probe.close(resolve))

          const cluster = mysql2.createPoolCluster()
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
            acquireStartCh.unsubscribe(acquireStart)
            acquireFinishCh.unsubscribe(acquireFinish)
            await new Promise(resolve => cluster.end(resolve))
          }
        })
      })
    })
  })
})
