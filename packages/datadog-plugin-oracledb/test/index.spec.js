const { expect } = require('chai')
const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

wrapIt()

const config = {
  user: 'test',
  password: 'Oracle18',
  connectString: 'localhost:1521/xe'
}

const dbQuery = 'select current_timestamp from dual'

describe('Plugin', () => {
  let oracledb
  let connection
  let pool

  describe('oracledb', () => {
    withVersions(plugin, 'oracledb', version => {
      describe('without pool', () => {
        describe('without configuration', () => {
          before(async () => {
            await agent.load('oracledb')
            oracledb = require(`../../../versions/oracledb@${version}`).get()
            connection = await oracledb.getConnection(config)
          })
          after(async () => {
            await connection.close()
            await agent.close()
          })

          it('should be instrumented correctly with correct tags', done => {
            agent.use(traces => {
              expect(traces[0][0]).to.have.property('name', 'exec.query')
              expect(traces[0][0]).to.have.property('resource', dbQuery)
              expect(traces[0][0].meta).to.have.property('service', 'test')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('sql.query', 'select current_timestamp from dual')
              expect(traces[0][0].meta).to.have.property('db.instance', 'xe')
              expect(traces[0][0].meta).to.have.property('db.hostname', 'oracledb')
              expect(traces[0][0].meta).to.have.property('db.port', '1521')
            }).then(done, done)
            connection.execute(dbQuery)
          })
        })
        describe('with configuration', () => {
          before(async () => {
            await agent.load('oracledb', { service: 'custom' })
            oracledb = require(`../../../versions/oracledb@${version}`).get()
            connection = await oracledb.getConnection(config)
          })
          after(async () => {
            await connection.close()
            await agent.close()
          })

          it('should be instrumented correctly with correct tags', done => {
            agent.use(traces => {
              expect(traces[0][0]).to.have.property('service', 'custom')
            }).then(done, done)
            connection.execute(dbQuery)
          })
        })
        describe('without configuration with callback', () => {
          before((done) => {
            agent.load('oracledb').then(() => {
              oracledb = require(`../../../versions/oracledb@${version}`).get()
              oracledb.getConnection(config, (err, _connection) => {
                if (err) {
                  done(err)
                  return
                }
                connection = _connection
                done()
              })
            })
          })
          after(async () => {
            await connection.close()
            await agent.close()
          })

          it('should be instrumented correctly with correct tags', done => {
            let callbackRan
            connection.execute(dbQuery, err => {
              expect(err).to.be.null
              callbackRan = true
            })
            agent.use(traces => {
              expect(traces[0][0]).to.have.property('name', 'exec.query')
              expect(traces[0][0]).to.have.property('resource', dbQuery)
              expect(traces[0][0].meta).to.have.property('service', 'test')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('sql.query', 'select current_timestamp from dual')
              expect(traces[0][0].meta).to.have.property('db.instance', 'xe')
              expect(traces[0][0].meta).to.have.property('db.hostname', 'oracledb')
              expect(traces[0][0].meta).to.have.property('db.port', '1521')
              expect(callbackRan).to.be.true
            }).then(done, done)
          })
        })
      })
      describe('with pool', () => {
        describe('without configuration', () => {
          before(async () => {
            await agent.load('oracledb')
            oracledb = require(`../../../versions/oracledb@${version}`).get()
            pool = await oracledb.createPool(config)
            connection = await pool.getConnection()
          })
          after(async () => {
            await connection.close()
            await pool.close()
            await agent.close()
          })

          it('should be instrumented correctly with correct tags', done => {
            agent.use(traces => {
              expect(traces[0][0]).to.have.property('name', 'exec.query')
              expect(traces[0][0]).to.have.property('resource', dbQuery)
              expect(traces[0][0].meta).to.have.property('service', 'test')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('sql.query', 'select current_timestamp from dual')
              expect(traces[0][0].meta).to.have.property('db.instance', 'xe')
              expect(traces[0][0].meta).to.have.property('db.hostname', 'oracledb')
              expect(traces[0][0].meta).to.have.property('db.port', '1521')
            }).then(done, done)
            connection.execute(dbQuery)
          })
        })
      })
    })
  })
})
