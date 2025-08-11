'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const semver = require('semver')
const { prepareTestServerForIast } = require('../utils')
const { storage } = require('../../../../../datadog-core')
const { withVersions } = require('../../../setup/mocha')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString } = require('../../../../src/appsec/iast/taint-tracking/operations')
const vulnerabilityReporter = require('../../../../src/appsec/iast/vulnerability-reporter')

describe('sql-injection-analyzer with sequelize', () => {
  withVersions('sequelize', 'sequelize', sequelizeVersion => {
    /**
     * mysql2 3.9.4 causes an error when using it with sequelize 4.x, making sequelize plugin test to fail.
     * Constraint the test combination of sequelize and mysql2 to force run mysql2 <3.9.4 with sequelize 4.x
     */
    const sequelizeSpecificVersion = require(`../../../../../../versions/sequelize@${sequelizeVersion}`).version()
    const compatibleMysql2VersionRange = semver.satisfies(sequelizeSpecificVersion, '>=5') ? '>=1' : '>=1 <3.9.4'
    withVersions('mysql2', 'mysql2', compatibleMysql2VersionRange, () => {
      let sequelize

      prepareTestServerForIast('sequelize + mysql2',
        (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
          beforeEach(() => {
            const Sequelize = require(`../../../../../../versions/sequelize@${sequelizeVersion}`).get()
            sequelize = new Sequelize('db', 'root', '', {
              host: '127.0.0.1',
              dialect: 'mysql'
            })
            vulnerabilityReporter.clearCache()
            return sequelize.authenticate()
          })

          afterEach(() => {
            sequelize.close()
          })

          testThatRequestHasVulnerability(() => {
            const store = storage('legacy').getStore()
            const iastCtx = iastContextFunctions.getIastContext(store)

            let sql = 'SELECT 1'
            sql = newTaintedString(iastCtx, sql, 'param', 'Request')

            return sequelize.query(sql)
          }, 'SQL_INJECTION', { occurrences: 1 })

          const externalFileContent = `'use strict'

function main (sequelize, sql) {
  return sequelize.query(sql)
}

function doubleCall (sequelize, sql) {
  sequelize.query(sql)
  return sequelize.query(sql)
}

async function doubleChainedCall (sequelize, sql) {
  await sequelize.query(sql)
  return sequelize.query(sql)
}

module.exports = { main, doubleCall, doubleChainedCall }
`
          testThatRequestHasVulnerability(() => {
            const filepath = path.join(os.tmpdir(), 'test-sequelize-sqli.js')
            fs.writeFileSync(filepath, externalFileContent)

            const store = storage('legacy').getStore()
            const iastCtx = iastContextFunctions.getIastContext(store)

            let sql = 'SELECT 1'
            sql = newTaintedString(iastCtx, sql, 'param', 'Request')

            return require(filepath).main(sequelize, sql)
          }, 'SQL_INJECTION', {
            occurrences: 1,
            location: {
              path: 'test-sequelize-sqli.js',
              line: 4
            }
          })

          testThatRequestHasVulnerability(() => {
            const filepath = path.join(os.tmpdir(), 'test-sequelize-sqli.js')
            fs.writeFileSync(filepath, externalFileContent)

            const store = storage('legacy').getStore()
            const iastCtx = iastContextFunctions.getIastContext(store)

            let sql = 'SELECT 1'
            sql = newTaintedString(iastCtx, sql, 'param', 'Request')

            return require(filepath).doubleCall(sequelize, sql)
          }, 'SQL_INJECTION', {
            occurrences: 2
          })

          testThatRequestHasVulnerability(() => {
            const filepath = path.join(os.tmpdir(), 'test-sequelize-sqli.js')
            fs.writeFileSync(filepath, externalFileContent)

            const store = storage('legacy').getStore()
            const iastCtx = iastContextFunctions.getIastContext(store)

            let sql = 'SELECT 1'
            sql = newTaintedString(iastCtx, sql, 'param', 'Request')

            return require(filepath).doubleChainedCall(sequelize, sql)
          }, 'SQL_INJECTION', {
            occurrences: 2
          })

          testThatRequestHasNoVulnerability(() => {
            return sequelize.query('SELECT 1')
          }, 'SQL_INJECTION')
        })
    })
  })
})
