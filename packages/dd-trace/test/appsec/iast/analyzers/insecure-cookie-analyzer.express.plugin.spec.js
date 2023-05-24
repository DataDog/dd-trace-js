'use strict'

const { prepareTestServerForIastInExpress } = require('../utils')
const fs = require('fs')
const os = require('os')
const path = require('path')
describe('Insecure cookie vulnerability', () => {
  let setCookieFunctions
  const setCookieFunctionsFilename = 'set-cookie-express-functions.js'
  const setCookieFunctionsPath = path.join(os.tmpdir(), setCookieFunctionsFilename)

  before(() => {
    fs.copyFileSync(path.join(__dirname, 'resources', 'set-cookie-express-functions.js'), setCookieFunctionsPath)
    setCookieFunctions = require(setCookieFunctionsPath)
  })

  after(() => {
    fs.rmSync(setCookieFunctionsPath)
  })

  withVersions('express', 'express', version => {
    prepareTestServerForIastInExpress('in express', version,
      (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
        testThatRequestHasVulnerability((req, res) => {
          setCookieFunctions.insecureWithResCookieMethod('insecure', 'cookie', res)
        }, 'INSECURE_COOKIE', {
          occurrences: 1,
          location: {
            path: setCookieFunctionsFilename,
            line: 4
          }
        })

        testThatRequestHasVulnerability((req, res) => {
          setCookieFunctions.insecureWithResHeaderMethod('insecure', 'cookie', res)
        }, 'INSECURE_COOKIE', {
          occurrences: 1,
          location: {
            path: setCookieFunctionsFilename,
            line: 8
          }
        })

        testThatRequestHasVulnerability((req, res) => {
          setCookieFunctions.insecureWithResHeaderMethodWithArray('insecure', 'cookie', 'insecure2', 'cookie2', res)
        }, 'INSECURE_COOKIE', {
          occurrences: 2,
          location: {
            path: setCookieFunctionsFilename,
            line: 12
          }
        })

        testThatRequestHasNoVulnerability((req, res) => {
          res.cookie('insecure', 'cookie', { secure: true })
        }, 'INSECURE_COOKIE')
      })
  })
})
