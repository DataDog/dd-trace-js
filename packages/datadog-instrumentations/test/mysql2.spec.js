'use strict'

const { channel } = require('../src/helpers/instrument')
const agent = require('../../dd-trace/test/plugins/agent')
const { assert } = require('chai')
const semver = require('semver')
const { once } = require('events')

describe('mysql2 instrumentation', () => {
  withVersions('mysql2', 'mysql2', version => {
    function abort ({ sql, abortController }) {
      assert.isString(sql)
      const error = new Error('Test')
      abortController.abort(error)
    }

    function noop () {}

    const config = {
      host: '127.0.0.1',
      user: 'root',
      database: 'db'
    }

    const sql = 'SELECT 1'
    let startCh, mysql2, shouldEmitEndAfterQueryAbort
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
                assert.propertyVal(err, 'message', 'Test')
                sinon.assert.notCalled(apmQueryStart)

                if (!shouldEmitEndAfterQueryAbort) done()
              })

              query.on('end', () => done())
            })

            it('should work without abortController.abort()', (done) => {
              startCh.subscribe(noop)
              connection.query(sql, (err) => {
                assert.isNull(err)
                sinon.assert.called(apmQueryStart)

                done()
              })
            })

            it('should work without subscriptions', (done) => {
              connection.query(sql, (err) => {
                assert.isNull(err)
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
                assert.propertyVal(err, 'message', 'Test')
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
                assert.propertyVal(err, 'message', 'Test')
                sinon.assert.notCalled(apmQueryStart)

                if (!shouldEmitEndAfterQueryAbort) done()
              }, null, {})
              connection.query(query)

              query.on('end', () => done())
            })

            it('should work without abortController.abort()', (done) => {
              startCh.subscribe(noop)

              const query = mysql2.Connection.createQuery(sql, (err) => {
                assert.isNull(err)
                sinon.assert.called(apmQueryStart)

                done()
              }, null, {})

              connection.query(query)
            })

            it('should work without subscriptions', (done) => {
              const query = mysql2.Connection.createQuery(sql, (err) => {
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

              const query = mysql2.Connection.createQuery(sql, null, null, {})
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
              assert.propertyVal(err, 'message', 'Test')
              sinon.assert.notCalled(apmQueryStart)

              done()
            })

            assert.equal(commandExecute.sql, options.sql)
          })

          it('should work without abortController.abort()', (done) => {
            startCh.subscribe(noop)

            const options = { sql }

            connection.execute(options, (err) => {
              assert.isNull(err)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })

          it('should work without subscriptions', (done) => {
            const options = { sql }

            connection.execute(options, (err) => {
              assert.isNull(err)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })
        })

        describe('with sql as string', () => {
          it('should abort the query on abortController.abort()', (done) => {
            startCh.subscribe(abort)

            connection.execute(sql, (err) => {
              assert.propertyVal(err, 'message', 'Test')
              sinon.assert.notCalled(apmQueryStart)
              done()
            })
          })

          it('should work without abortController.abort()', (done) => {
            startCh.subscribe(noop)

            connection.execute(sql, (err) => {
              assert.isNull(err)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })

          it('should work without subscriptions', (done) => {
            const options = { sql }

            connection.execute(options, (err) => {
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

      before(() => {
        pool = mysql2.createPool(config)
      })

      describe('Pool.prototype.query', () => {
        describe('with object as query', () => {
          describe('with callback', () => {
            it('should abort the query on abortController.abort()', (done) => {
              startCh.subscribe(abort)
              const query = pool.query({ sql }, (err) => {
                assert.propertyVal(err, 'message', 'Test')
                sinon.assert.notCalled(apmQueryStart)

                if (!shouldEmitEndAfterQueryAbort) done()
              })

              query.on('end', () => done())
            })

            it('should work without abortController.abort()', (done) => {
              startCh.subscribe(noop)

              pool.query({ sql }, (err) => {
                assert.isNull(err)
                sinon.assert.called(apmQueryStart)

                done()
              })
            })

            it('should work without subscriptions', (done) => {
              pool.query({ sql }, (err) => {
                assert.isNull(err)
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
                assert.propertyVal(err, 'message', 'Test')
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
                assert.isNull(err)
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
                assert.propertyVal(err, 'message', 'Test')
                sinon.assert.notCalled(apmQueryStart)

                if (!shouldEmitEndAfterQueryAbort) done()
              })

              query.on('end', () => done())
            })

            it('should work without abortController.abort()', (done) => {
              startCh.subscribe(noop)

              pool.query(sql, (err) => {
                assert.isNull(err)
                sinon.assert.called(apmQueryStart)

                done()
              })
            })

            it('should work without subscriptions', (done) => {
              pool.query(sql, (err) => {
                assert.isNull(err)
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
                assert.propertyVal(err, 'message', 'Test')
                sinon.assert.notCalled(apmQueryStart)
                if (!shouldEmitEndAfterQueryAbort) done()
              })

              query.on('end', () => done())
            })

            it('should work without abortController.abort()', async () => {
              startCh.subscribe(noop)
              const query = pool.query(sql)

              expect(query.listenerCount('error')).to.equal(0)

              await once(query, 'end')

              expect(query.listenerCount('error')).to.equal(0)

              sinon.assert.called(apmQueryStart)
            })

            it('should work without subscriptions', (done) => {
              pool.query(sql, (err) => {
                assert.isNull(err)
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
                assert.propertyVal(err, 'message', 'Test')

                setTimeout(() => {
                  sinon.assert.notCalled(apmQueryStart)
                  done()
                }, 100)
              })
            })

            it('should work without abortController.abort()', (done) => {
              startCh.subscribe(noop)

              pool.execute({ sql }, (err) => {
                assert.isNull(err)
                sinon.assert.called(apmQueryStart)

                done()
              })
            })

            it('should work without subscriptions', (done) => {
              pool.execute({ sql }, (err) => {
                assert.isNull(err)
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
                assert.propertyVal(err, 'message', 'Test')

                setTimeout(() => {
                  sinon.assert.notCalled(apmQueryStart)
                  done()
                }, 100)
              })
            })

            it('should work without abortController.abort()', (done) => {
              startCh.subscribe(noop)

              pool.execute(sql, (err) => {
                assert.isNull(err)
                sinon.assert.called(apmQueryStart)

                done()
              })
            })

            it('should work without subscriptions', (done) => {
              pool.execute(sql, (err) => {
                assert.isNull(err)
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
            namespace.query(sql, (err) => {
              assert.isNull(err)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })

          it('should work without subscriptions', (done) => {
            const namespace = poolCluster.of()
            namespace.query(sql, (err) => {
              assert.isNull(err)
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
            namespace.query({ sql }, (err) => {
              assert.isNull(err)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })

          it('should work without subscriptions', (done) => {
            const namespace = poolCluster.of()
            namespace.query({ sql }, (err) => {
              assert.isNull(err)
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
            namespace.execute(sql, (err) => {
              assert.isNull(err)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })

          it('should work without subscriptions', (done) => {
            const namespace = poolCluster.of()
            namespace.execute(sql, (err) => {
              assert.isNull(err)
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
            namespace.execute({ sql }, (err) => {
              assert.isNull(err)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })

          it('should work without subscriptions', (done) => {
            const namespace = poolCluster.of()
            namespace.execute({ sql }, (err) => {
              assert.isNull(err)
              sinon.assert.called(apmQueryStart)

              done()
            })
          })
        })
      })
    })
  })
})
