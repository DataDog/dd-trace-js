'use strict'

const { prepareTestServerForIast } = require('../utils')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString } = require('../../../../src/appsec/iast/taint-tracking/operations')
const vulnerabilityReporter = require('../../../../src/appsec/iast/vulnerability-reporter')
const agent = require('../../../plugins/agent')

const base = 'dc=example,dc=org'

describe('ldap-injection-analyzer with ldapjs', () => {
  let client
  withVersions('ldapjs', 'ldapjs', version => {
    prepareTestServerForIast('ldapjs', (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
      beforeEach(async () => {
        await agent.load('ldapjs')
        vulnerabilityReporter.clearCache()
        const ldapjs = require(`../../../../../../versions/ldapjs@${version}`).get()
        client = ldapjs.createClient({
          url: 'ldap://localhost:1389'
        })
        return new Promise((resolve) => {
          client.bind(`cn=admin,${base}`, 'adminpassword', resolve)
        })
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

      describe('context is not null after search end event', () => {
        testThatRequestHasVulnerability(() => {
          return new Promise((resolve, reject) => {
            const store = storage.getStore()
            const iastCtx = iastContextFunctions.getIastContext(store)

            let filter = '(objectClass=*)'
            filter = newTaintedString(iastCtx, filter, 'param', 'Request')

            client.search(base, filter, (err, searchRes) => {
              searchRes.on('end', () => {
                const storeEnd = storage.getStore()
                const iastCtxEnd = iastContextFunctions.getIastContext(storeEnd)
                expect(iastCtxEnd).to.not.be.undefined

                resolve()
              })
              searchRes.on('error', reject)
            })
          })
        }, 'LDAP_INJECTION')
      })

      describe('remove listener should work as expected', () => {
        testThatRequestHasVulnerability(() => {
          return new Promise((resolve, reject) => {
            const store = storage.getStore()
            const iastCtx = iastContextFunctions.getIastContext(store)

            let filter = '(objectClass=*)'
            filter = newTaintedString(iastCtx, filter, 'param', 'Request')

            let searchResOnEndInvocations = 0
            client.search(base, filter, (err, searchRes) => {
              const onSearchEnd = () => {
                searchResOnEndInvocations++
                searchRes.off('end', onSearchEnd)
                searchRes.emit('end')

                // if .off method wouldn't work the test will never reach this lines because it will loop forever :S
                expect(searchResOnEndInvocations).to.be.eq(1)
                resolve()
              }

              searchRes.on('end', onSearchEnd)
            })
          })
        }, 'LDAP_INJECTION')
      })
    })
  })
})
