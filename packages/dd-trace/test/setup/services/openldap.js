'use strict'

const RetryOperation = require('../operation')
const ldapjs = require('../../../../../versions/ldapjs').get()

function waitForOpenLdap () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('ldap')

    operation.attempt(currentAttempt => {
      const base = 'dc=example,dc=org'
      const client = ldapjs.createClient({
        url: 'ldap://localhost:1389'
      })
      client.bind(`cn=admin,${base}`, 'adminpassword', (err) => {
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      })
    })
  })
}

module.exports = waitForOpenLdap