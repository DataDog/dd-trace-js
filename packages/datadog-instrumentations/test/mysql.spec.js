'use strict'

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
    let mysql, acquireStartCh, acquireStart

    before(() => agent.load(['mysql']))

    before(() => {
      mysql = require(`../../../versions/mysql@${version}`).get()
      acquireStartCh = channel('apm:mysql:pool:acquire:start')
    })

    afterEach(() => {
      if (acquireStart !== undefined) {
        acquireStartCh.unsubscribe(acquireStart)
        acquireStart = undefined
      }
    })

    describe('lib/PoolNamespace.js', function () {
      before(function () {
        // PoolNamespace#query was added after mysql 2.0.0.
        const probe = mysql.createPoolCluster()
        probe.add('live', config)
        const supported = typeof probe.of('*').query === 'function'
        probe.end(() => {})
        if (!supported) this.skip()
      })

      // A pool-cluster query acquires its connection internally, so it must report the wait as a tag
      // on the query span rather than open a standalone acquire span. `apm:mysql:pool:acquire:start`
      // is the channel that opens that span, so its absence is the signal the acquire was suppressed.
      it('does not open an acquire span for a pool cluster query', (done) => {
        acquireStart = sinon.stub()
        acquireStartCh.subscribe(acquireStart)

        const cluster = mysql.createPoolCluster()
        cluster.add('live', { ...config, connectionLimit: 1 })
        const namespace = cluster.of('*')

        namespace.query(sql, (error) => {
          if (error) {
            cluster.end(() => done(error))
            return
          }

          try {
            sinon.assert.notCalled(acquireStart)
          } catch (assertionError) {
            cluster.end(() => done(assertionError))
            return
          }

          cluster.end(() => done())
        })
      })

      it('treats the retried internal acquire of a failover cluster query as a pooled-query acquire', (done) => {
        // A pool cluster with `canRetry` (the default) retries on the next node when the first acquire
        // fails. The retry re-invokes `query` from the first acquire's async failure callback, so the
        // failover acquire must stay suppressed rather than open a standalone acquire span.
        acquireStart = sinon.stub()
        acquireStartCh.subscribe(acquireStart)

        const probe = net.createServer()
        probe.listen(0, '127.0.0.1', () => {
          const deadPort = probe.address().port

          probe.close(() => {
            const cluster = mysql.createPoolCluster()
            cluster.add('dead', { ...config, port: deadPort, connectionLimit: 1, connectTimeout: 500 })
            cluster.add('live', { ...config, connectionLimit: 1 })
            cluster.on('warn', () => {})
            const namespace = cluster.of('*')

            namespace.query(sql, (error) => {
              if (error) {
                cluster.end(() => done(error))
                return
              }

              try {
                sinon.assert.notCalled(acquireStart)
              } catch (assertionError) {
                cluster.end(() => done(assertionError))
                return
              }

              cluster.end(() => done())
            })
          })
        })
      })
    })
  })
})
