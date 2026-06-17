'use strict'

const assert = require('node:assert/strict')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

function createMockConnection (r, opts) {
  const conn = new r.Connection(opts, () => {})
  if (conn.rawSocket) {
    conn.rawSocket.destroy()
  }
  conn.open = true
  conn.host = opts.host || 'localhost'
  conn.port = opts.port || 28015
  conn.db = opts.db

  conn._sendQuery = function () {}
  conn._writeQuery = function () {}

  return conn
}

describe('Plugin', () => {
  describe('rethinkdb', () => {
    withVersions('rethinkdb', 'rethinkdb', (version) => {
      let r

      beforeEach(() => {
        return agent.load('rethinkdb')
      })

      beforeEach(() => {
        r = require(`../../../versions/rethinkdb@${version}`)
      })

      afterEach(() => {
        return agent.close({ ritmReset: false })
      })

      it('should create a span on query start', (done) => {
        const expectedSpanPromise = agent.assertFirstTraceSpan({
          name: 'rethinkdb.query',
          service: 'test',
          type: 'sql',
          meta: {
            component: 'rethinkdb',
            'db.type': 'rethinkdb'
          }
        })

        const conn = createMockConnection(r, { db: 'test' })
        const query = r.table('users')

        conn._start(query, () => {
          expectedSpanPromise.then(() => done()).catch(done)
        }, {})
      })

      it('should include connection details in span tags', (done) => {
        const expectedSpanPromise = agent.assertFirstTraceSpan({
          name: 'rethinkdb.query',
          service: 'test',
          type: 'sql',
          meta: {
            component: 'rethinkdb',
            'db.type': 'rethinkdb',
            'db.name': 'testdb',
            'out.host': 'db.example.com'
          }
        })

        const conn = createMockConnection(r, { host: 'db.example.com', port: 28015, db: 'testdb' })
        const query = r.table('users')

        conn._start(query, () => {
          expectedSpanPromise.then(() => done()).catch(done)
        }, {})
      })

      it('should handle errors', (done) => {
        const expectedSpanPromise = agent.assertFirstTraceSpan({
          name: 'rethinkdb.query',
          service: 'test',
          type: 'sql',
          meta: {
            component: 'rethinkdb',
            'db.type': 'rethinkdb'
          }
        })

        const conn = createMockConnection(r, { db: 'test' })
        const query = r.table('users')

        conn._start(query, (err) => {
          assert.ok(err)
          expectedSpanPromise.then(() => done()).catch(done)
        }, {})

        const token = conn.nextToken - 1
        conn._processResponse({
          t: 16,
          r: ['Test error'],
          b: []
        }, token)
      })
    })
  })
})
