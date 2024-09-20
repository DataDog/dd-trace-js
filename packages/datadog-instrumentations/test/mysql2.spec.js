'use strict'

const { channel } = require('../src/helpers/instrument')
const agent = require('../../dd-trace/test/plugins/agent')
const { assert } = require('chai')
const semver = require('semver')

describe('mysql2 instrumentation', () => {
  withVersions('mysql2', 'mysql2', version => {
    function abort ({ abortController }) {
      const error = new Error('Test')
      abortController.abort(error)

      if (!abortController.signal.reason) {
        abortController.signal.reason = error
      }
    }

    function noop () {}

    const config = {
      host: '127.0.0.1',
      user: 'root',
      database: 'db'
    }

    let startCh, mysql2, shouldEmitEndAfterQueryAbort
    let apmQueryStartChannel, apmQueryStart, mysql2Version

    before(() => {
      startCh = channel('datadog:mysql2:outerquery:start')
      return agent.load(['mysql2'])
    })

    beforeEach(() => {
      const mysql2Require = require(`../../../versions/mysql2@${version}`)
      mysql2Version = mysql2Require.version()
      // in v1.3.3 CommandQuery started to emit 'end' after 'error' event
      shouldEmitEndAfterQueryAbort = semver.intersects(mysql2Version, '>=1.3.3')
      mysql2 = mysql2Require.get()

      apmQueryStartChannel = channel('apm:mysql2:query:start')
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
              const query = connection.query('SELECT 1', (err, _) => {
                assert.propertyVal(err, 'message', 'Test')
                sinon.assert.notCalled(apmQueryStart)

                if (!shouldEmitEndAfterQueryAbort) done()
              })

              query.on('end', () => done())
            })

            it('should work without abortController.abort()', (done) => {
              startCh.subscribe(noop)
              connection.query('SELECT 1', (err, _) => {
                assert.isNull(err)
                sinon.assert.called(apmQueryStart)

                done()
              })
            })

            it('should work without subscriptions', (done) => {
              connection.query('SELECT 1', (err, _) => {
                assert.isNull(err)
                sinon.assert.called(apmQueryStart)

                done()
              })
            })
          })

          describe('without callback', () => {
            it('should abort the query on abortController.abort()', (done) => {
              startCh.subscribe(abort)

              const query = connection.query('SELECT 1')

              query.on('error', (err) => {
                assert.propertyVal(err, 'message', 'Test')
                sinon.assert.notCalled(apmQueryStart)
                if (!shouldEmitEndAfterQueryAbort) done()
              })

              query.on('end', () => done())
            })

            it('should work without abortController.abort()', (done) => {
              startCh.subscribe(noop)

              const query = connection.query('SELECT 1')

              query.on('error', (err) => done(err))
              query.on('end', () => {
                sinon.assert.called(apmQueryStart)

                done()
              })
            })

            it('should work without subscriptions', (done) => {
              const query = connection.query('SELECT 1')

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
              const query = mysql2.Connection.createQuery('SELECT 1', (err, _) => {
                assert.propertyVal(err, 'message', 'Test')
                sinon.assert.notCalled(apmQueryStart)

                if (!shouldEmitEndAfterQueryAbort) done()
              }, null, {})
              connection.query(query)

              query.on('end', () => done())
            })

            it('should work without abortController.abort()', (done) => {
              startCh.subscribe(noop)

              const query = mysql2.Connection.createQuery('SELECT 1', (err, _) => {
                assert.isNull(err)
                sinon.assert.called(apmQueryStart)

                done()
              }, null, {})

              connection.query(query)
            })

            it('should work without subscriptions', (done) => {
              const query = mysql2.Connection.createQuery('SELECT 1', (err, _) => {
                assert.isNull(err)
                sinon.assert.called(apmQueryStart)

                done()
              }, null, {})

              connection.query(query)
            })
          })

          describe('without callback', () => {
            it('should abort the query on abortController.abort()', (done) => {
              startCh.subscribe(abort)

              const query = mysql2.Connection.createQuery('SELECT 1', null, null, {})
              query.on('error', (err) => {
                assert.propertyVal(err, 'message', 'Test')
                sinon.assert.notCalled(apmQueryStart)

                if (!shouldEmitEndAfterQueryAbort) done()
              })

              connection.query(query)

              query.on('end', () => done())
            })

            it('should work without abortController.abort()', (done) => {
              startCh.subscribe(noop)

              const query = mysql2.Connection.createQuery('SELECT 1', null, null, {})
              query.on('error', (err) => done(err))
              query.on('end', () => {
                sinon.assert.called(apmQueryStart)

                done()
              })

              connection.query(query)
            })

            it('should work without subscriptions', (done) => {
              const query = mysql2.Connection.createQuery('SELECT 1', null, null, {})
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

            const options = {
              sql: 'SELECT 1'
            }
            const commandExecute = connection.execute(options, (err, _) => {
              assert.propertyVal(err, 'message', 'Test')
              sinon.assert.notCalled(apmQueryStart)

              done()
            })

            assert.equal(commandExecute.sql, options.sql)
          })

          it('should work without abortController.abort()', (done) => {
            startCh.subscribe(noop)

            const options = {
              sql: 'SELECT 1'
            }

            connection.execute(options, (err, _) => {
              assert.isNull(err)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })

          it('should work without subscriptions', (done) => {
            const options = {
              sql: 'SELECT 1'
            }

            connection.execute(options, (err, _) => {
              assert.isNull(err)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })
        })

        describe('with sql as string', () => {
          it('should abort the query on abortController.abort()', (done) => {
            startCh.subscribe(abort)

            connection.execute('SELECT 1', (err, _) => {
              assert.propertyVal(err, 'message', 'Test')
              sinon.assert.notCalled(apmQueryStart)
              done()
            })
          })

          it('should work without abortController.abort()', (done) => {
            startCh.subscribe(noop)

            connection.execute('SELECT 1', (err, _) => {
              assert.isNull(err)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })

          it('should work without subscriptions', (done) => {
            const options = {
              sql: 'SELECT 1'
            }

            connection.execute(options, (err, _) => {
              assert.isNull(err)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })
        })
      })
    })

    describe('lib/pool.js', () => {
      let pool

      beforeEach(() => {
        pool = mysql2.createPool(config)
      })

      describe('Pool.prototype.query', () => {
        describe('with callback', () => {
          it('should abort the query on abortController.abort()', (done) => {
            startCh.subscribe(abort)
            const query = pool.query('SELECT 1', (err, _) => {
              assert.propertyVal(err, 'message', 'Test')
              sinon.assert.notCalled(apmQueryStart)

              if (!shouldEmitEndAfterQueryAbort) done()
            })

            query.on('end', () => done())
          })

          it('should work without abortController.abort()', (done) => {
            startCh.subscribe(noop)

            pool.query('SELECT 1', (err, _) => {
              assert.isNull(err)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })

          it('should work without subscriptions', (done) => {
            pool.query('SELECT 1', (err, _) => {
              assert.isNull(err)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })
        })

        describe('without callback', () => {
          it('should abort the query on abortController.abort()', (done) => {
            startCh.subscribe(abort)
            const query = pool.query('SELECT 1')
            query.on('error', err => {
              assert.propertyVal(err, 'message', 'Test')
              sinon.assert.notCalled(apmQueryStart)
              if (!shouldEmitEndAfterQueryAbort) done()
            })

            query.on('end', () => done())
          })

          it('should work without abortController.abort()', (done) => {
            startCh.subscribe(noop)
            const query = pool.query('SELECT 1')

            query.on('error', err => done(err))
            query.on('end', () => {
              sinon.assert.called(apmQueryStart)

              done()
            })
          })

          it('should work without subscriptions', (done) => {
            pool.query('SELECT 1', (err, _) => {
              assert.isNull(err)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })
        })
      })

      describe('Pool.prototype.execute', () => {
        describe('with callback', () => {
          it('should abort the query on abortController.abort()', (done) => {
            startCh.subscribe(abort)
            pool.execute('SELECT 1', (err, _) => {
              assert.propertyVal(err, 'message', 'Test')

              setTimeout(() => {
                sinon.assert.notCalled(apmQueryStart)
                done()
              }, 100)
            })
          })

          it('should work without abortController.abort()', (done) => {
            startCh.subscribe(noop)

            pool.execute('SELECT 1', (err, _) => {
              assert.isNull(err)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })

          it('should work without subscriptions', (done) => {
            pool.execute('SELECT 1', (err, _) => {
              assert.isNull(err)
              sinon.assert.called(apmQueryStart)

              done()
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
        it('should abort the query on abortController.abort()', (done) => {
          startCh.subscribe(abort)
          const namespace = poolCluster.of()
          namespace.query('SELECT 1', (err, _) => {
            assert.propertyVal(err, 'message', 'Test')

            setTimeout(() => {
              sinon.assert.notCalled(apmQueryStart)
              done()
            }, 100)
          })
        })

        it('should work without abortController.abort()', (done) => {
          startCh.subscribe(noop)

          const namespace = poolCluster.of()
          namespace.query('SELECT 1', (err, _) => {
            assert.isNull(err)
            sinon.assert.called(apmQueryStart)

            done()
          })
        })

        it('should work without subscriptions', (done) => {
          const namespace = poolCluster.of()
          namespace.query('SELECT 1', (err, _) => {
            assert.isNull(err)
            sinon.assert.called(apmQueryStart)

            done()
          })
        })
      })

      describe('PoolNamespace.prototype.execute', () => {
        it('should abort the query on abortController.abort()', (done) => {
          startCh.subscribe(abort)

          const namespace = poolCluster.of()
          namespace.execute('SELECT 1', (err, _) => {
            assert.propertyVal(err, 'message', 'Test')

            setTimeout(() => {
              sinon.assert.notCalled(apmQueryStart)
              done()
            }, 100)
          })
        })

        it('should work without abortController.abort()', (done) => {
          startCh.subscribe(noop)

          const namespace = poolCluster.of()
          namespace.execute('SELECT 1', (err, _) => {
            assert.isNull(err)
            sinon.assert.called(apmQueryStart)

            done()
          })
        })

        it('should work without subscriptions', (done) => {
          const namespace = poolCluster.of()
          namespace.execute('SELECT 1', (err, _) => {
            assert.isNull(err)
            sinon.assert.called(apmQueryStart)

            done()
          })
        })
      })
    })
  })
})
