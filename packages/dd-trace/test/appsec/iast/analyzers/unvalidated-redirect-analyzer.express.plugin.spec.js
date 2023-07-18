'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const { UNVALIDATED_REDIRECT } = require('../../../../src/appsec/iast/vulnerabilities')
const { prepareTestServerForIastInExpress } = require('../utils')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString } = require('../../../../src/appsec/iast/taint-tracking/operations')

describe('Unvalidated Redirect vulnerability', () => {
  let redirectFunctions
  const redirectFunctionsFilename = 'redirect-express-functions.js'
  const redirectFunctionsPath = path.join(os.tmpdir(), redirectFunctionsFilename)

  before(() => {
    fs.copyFileSync(path.join(__dirname, 'resources', redirectFunctionsFilename), redirectFunctionsPath)
    redirectFunctions = require(redirectFunctionsPath)
  })

  after(() => {
    fs.unlinkSync(redirectFunctionsPath)
  })

  withVersions('express', 'express', version => {
    prepareTestServerForIastInExpress('in express', version,
      (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
        testThatRequestHasVulnerability((req, res) => {
          const store = storage.getStore()
          const iastCtx = iastContextFunctions.getIastContext(store)
          const location = newTaintedString(iastCtx, 'https://app.com?id=tron', 'param', 'Request')
          redirectFunctions.insecureWithResHeaderMethod('location', location, res)
        }, UNVALIDATED_REDIRECT, {
          occurrences: 1,
          location: {
            path: redirectFunctionsFilename,
            line: 4
          }
        })

        testThatRequestHasVulnerability((req, res) => {
          const store = storage.getStore()
          const iastCtx = iastContextFunctions.getIastContext(store)
          const location = newTaintedString(iastCtx, 'http://user@app.com/', 'param', 'Request')
          redirectFunctions.insecureWithResRedirectMethod(location, res)
        }, UNVALIDATED_REDIRECT, {
          occurrences: 1,
          location: {
            path: redirectFunctionsFilename,
            line: 8
          }
        })

        testThatRequestHasVulnerability((req, res) => {
          const store = storage.getStore()
          const iastCtx = iastContextFunctions.getIastContext(store)
          const location = newTaintedString(iastCtx, 'http://user@app.com/', 'param', 'Request')
          redirectFunctions.insecureWithResLocationMethod(location, res)
        }, UNVALIDATED_REDIRECT, {
          occurrences: 1,
          location: {
            path: redirectFunctionsFilename,
            line: 12
          }
        })

        testThatRequestHasNoVulnerability((req, res) => {
          const store = storage.getStore()
          const iastCtx = iastContextFunctions.getIastContext(store)
          const location = newTaintedString(iastCtx, 'http://user@app.com/', 'pathParam', 'Request')
          res.header('X-test', location)
        }, UNVALIDATED_REDIRECT)

        testThatRequestHasNoVulnerability((req, res) => {
          redirectFunctions.insecureWithResHeaderMethod('location', 'http://user@app.com/', res)
        }, UNVALIDATED_REDIRECT)
      })
  })
})
