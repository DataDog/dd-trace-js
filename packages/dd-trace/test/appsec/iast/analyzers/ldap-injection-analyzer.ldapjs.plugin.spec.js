'use strict'

const { testThatRequestHasVulnerability, testThatRequestHasNoVulnerability } = require('../utils')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString } = require('../../../../src/appsec/iast/taint-tracking/operations')
const vulnerabilityReporter = require('../../../../src/appsec/iast/vulnerability-reporter')
const agent = require('../../../plugins/agent')

const base = 'dc=example,dc=org'

describe('ldap-injection-analyzer with ldapjs', () => {
  let client
  withVersions('ldapjs', 'ldapjs', version => {
    describe('ldapjs', () => {
      beforeEach(async () => {
        await agent.load('ldapjs')
        vulnerabilityReporter.clearCache()
        const ldapjs = require(`../../../../../../versions/ldapjs@${version}`).get()
        client = ldapjs.createClient({
          url: 'ldap://localhost:1389'
        })
        client.bind(`cn=admin,${base}`, 'adminpassword', (err) => {})
      })

      afterEach((done) => {
        client.unbind(done)
      })

      describe('has vulnerability', () => {
        testThatRequestHasVulnerability(() => {
          return new Promise((resolve, reject) => {
            const store = storage.getStore()
            const iastCtx = iastContextFunctions.getIastContext(store)

            let filter = '(objectClass=*)'
            filter = newTaintedString(iastCtx, filter, 'param', 'Request')

            client.search(base, filter, (err, searchRes) => {
              searchRes.on('end', resolve)
              searchRes.on('error', reject)
            })
          })
        }, 'LDAP_INJECTION')
      })

      describe('has no vulnerability', () => {
        testThatRequestHasNoVulnerability(() => {
          return new Promise((resolve, reject) => {
            const filter = '(objectClass=*)'
            client.search(base, filter, (err, searchRes) => {
              searchRes.on('end', resolve)
              searchRes.on('error', reject)
            })
          })
        }, 'LDAP_INJECTION')
      })
    })
  })
})
