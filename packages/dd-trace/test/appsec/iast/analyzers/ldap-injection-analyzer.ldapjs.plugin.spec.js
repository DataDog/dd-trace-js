'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

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
        return new Promise((resolve, reject) => {
          client.bind(`cn=admin,${base}`, 'adminpassword', (err) => {
            if (err) {
              reject(err)
            } else {
              resolve()
            }
          })
        })
      })

      afterEach((done) => {
        client.unbind(done)
      })

      describe('has vulnerability', () => {
        testThatRequestHasVulnerability(() => {
          return new Promise((resolve, reject) => {
            const store = storage('legacy').getStore()
            const iastCtx = iastContextFunctions.getIastContext(store)

            let filter = '(objectClass=*)'
            filter = newTaintedString(iastCtx, filter, 'param', 'Request')

            client.search(base, filter, (err, searchRes) => {
              if (err) {
                return reject(err)
              }
              searchRes
                .on('end', resolve)
                .on('error', reject)
            })
          })
        }, 'LDAP_INJECTION')
      })

      describe('has no vulnerability', () => {
        testThatRequestHasNoVulnerability(() => {
          return new Promise((resolve, reject) => {
            const filter = '(objectClass=*)'
            client.search(base, filter, (err, searchRes) => {
              if (err) {
                return reject(err)
              }
              searchRes
                .on('end', resolve)
                .on('error', reject)
            })
          })
        }, 'LDAP_INJECTION')
      })

      describe('context is not null after search end event', () => {
        testThatRequestHasVulnerability(() => {
          return new Promise((resolve, reject) => {
            const store = storage('legacy').getStore()
            const iastCtx = iastContextFunctions.getIastContext(store)

            let filter = '(objectClass=*)'
            filter = newTaintedString(iastCtx, filter, 'param', 'Request')

            client.search(base, filter, (err, searchRes) => {
              if (err) {
                return reject(err)
              }
              searchRes.on('end', () => {
                const storeEnd = storage('legacy').getStore()
                const iastCtxEnd = iastContextFunctions.getIastContext(storeEnd)
                expect(iastCtxEnd).to.not.be.undefined

                resolve()
              }).on('error', reject)
            })
          })
        }, 'LDAP_INJECTION')
      })

      describe('remove listener should work as expected', () => {
        testThatRequestHasVulnerability(() => {
          return new Promise((resolve, reject) => {
            const store = storage('legacy').getStore()
            const iastCtx = iastContextFunctions.getIastContext(store)

            let filter = '(objectClass=*)'
            filter = newTaintedString(iastCtx, filter, 'param', 'Request')

            let searchResOnEndInvocations = 0
            client.search(base, filter, (err, searchRes) => {
              if (err) {
                return reject(err)
              }
              const onSearchEnd = () => {
                searchResOnEndInvocations++
                searchRes
                  .off('end', onSearchEnd)
                  .emit('end')

                // if .off method wouldn't work the test will never reach this lines because it will loop forever :S
                expect(searchResOnEndInvocations).to.be.eq(1)
                resolve()
              }

              searchRes.on('end', onSearchEnd)
            })
          })
        }, 'LDAP_INJECTION')
      })

      describe('search inside bind should detect the vulnerability and not lose the context', () => {
        testThatRequestHasVulnerability(() => {
          return new Promise((resolve, reject) => {
            client.bind(`cn=admin,${base}`, 'adminpassword', (err) => {
              if (err) {
                reject(err)
              } else {
                const store = storage('legacy').getStore()
                const iastCtx = iastContextFunctions.getIastContext(store)

                let filter = '(objectClass=*)'
                filter = newTaintedString(iastCtx, filter, 'param', 'Request')

                client.search(base, filter, (err, searchRes) => {
                  if (err) {
                    return reject(err)
                  }
                  searchRes.on('end', () => {
                    const storeEnd = storage('legacy').getStore()
                    const iastCtxEnd = iastContextFunctions.getIastContext(storeEnd)
                    expect(iastCtxEnd).to.not.be.undefined

                    resolve()
                  }).on('error', reject)
                })
              }
            })
          })
        }, 'LDAP_INJECTION')
      })
    })
  })

  withVersions('ldapjs', 'ldapjs-promise', promiseVersion => {
    prepareTestServerForIast('ldapjs-promise', (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
      const srcFilePath = path.join(__dirname, 'resources', 'ldap-injection-methods.js')
      const dstFilePath = path.join(os.tmpdir(), 'ldap-injection-methods.js')
      let ldapMethods

      beforeEach(async () => {
        await agent.load('ldapjs')
        vulnerabilityReporter.clearCache()
        const ldapjs = require(`../../../../../../versions/ldapjs-promise@${promiseVersion}`).get()
        client = ldapjs.createClient({
          url: 'ldap://localhost:1389'
        })

        fs.copyFileSync(srcFilePath, dstFilePath)
        ldapMethods = require(dstFilePath)

        return client.bind(`cn=admin,${base}`, 'adminpassword')
      })

      afterEach(async () => {
        fs.unlinkSync(dstFilePath)
        await client.unbind()
      })

      describe('has vulnerability', () => {
        testThatRequestHasVulnerability(() => {
          const store = storage('legacy').getStore()
          const iastCtx = iastContextFunctions.getIastContext(store)

          let filter = '(objectClass=*)'
          filter = newTaintedString(iastCtx, filter, 'param', 'Request')

          return ldapMethods.executeSearch(client, base, filter)
        }, 'LDAP_INJECTION', {
          occurrences: 1,
          location: { path: 'ldap-injection-methods.js' }
        })
      })

      describe('has no vulnerability', () => {
        testThatRequestHasNoVulnerability(() => {
          const filter = '(objectClass=*)'
          return ldapMethods.executeSearch(client, base, filter)
        }, 'LDAP_INJECTION')
      })
    })
  })
})
