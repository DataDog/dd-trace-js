const { doesNotReject } = require('assert')
const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

wrapIt()

const config = {
  user: "sys",
  password: "Oracle18",
  connectString : "oracledb:1521/xe",
  privilege: 2, // oracledb.SYSDBA
  poolMax: 2,
  poolMin: 2,
  poolIncrement: 0
}

describe('Plugin', () => {
  let oracledb
  let tracer
  let connection
  describe('oracledb', () => {
    withVersions(plugin, 'oracledb', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      describe('without configuration', () => {
        before(() => {
          return agent.load('oracledb')
        })
        before(async() => {
          oracledb = require(`../../../versions/oracledb@${version}`).get()
          connection = await oracledb.getConnection(config)
        })
        after(() => {
          return agent.close()
        })

        it('test for oracledb', done => {
          agent.use(traces => {
            expect(traces[0][0]).to.have.property('name', 'exec.query')
            expect(traces[0][0]).to.have.property('resource', 'exec.query')
            expect(traces[0][0].meta).to.have.property('service', 'test')
            expect(traces[0][0].meta).to.have.property('span.kind', 'client')
            expect(traces[0][0].meta).to.have.property('sql.query', 'select current_timestamp from dual')
            expect(traces[0][0].meta).to.have.property('db.instance', 'xe')
            expect(traces[0][0].meta).to.have.property('db.hostname', 'oracledb')
            expect(traces[0][0].meta).to.have.property('db.port', '1521')
            done()
          })
          const dbQuery = 'select current_timestamp from dual'
          connection.execute(dbQuery)
        })
      })
    })
  })
})
