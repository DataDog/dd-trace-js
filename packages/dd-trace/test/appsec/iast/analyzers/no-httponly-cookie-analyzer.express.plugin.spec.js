'use strict'

const { prepareTestServerForIastInExpress } = require('../utils')
const fs = require('fs')
const os = require('os')
const path = require('path')

describe('no HttpOnly cookie vulnerability', () => {
  let setCookieFunctions
  const setCookieFunctionsFilename = 'set-cookie-express-functions.js'
  const setCookieFunctionsPath = path.join(os.tmpdir(), setCookieFunctionsFilename)

  before(() => {
    fs.copyFileSync(path.join(__dirname, 'resources', 'set-cookie-express-functions.js'), setCookieFunctionsPath)
    setCookieFunctions = require(setCookieFunctionsPath)
  })

  after(() => {
    fs.unlinkSync(setCookieFunctionsPath)
  })

  withVersions('express', 'express', version => {
    prepareTestServerForIastInExpress('in express', version,
      (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
        testThatRequestHasVulnerability((req, res) => {
          setCookieFunctions.insecureWithResCookieMethod('insecure', 'cookie', res)
        }, 'NO_HTTPONLY_COOKIE', {
          occurrences: 1,
          location: {
            path: setCookieFunctionsFilename,
            line: 4
          }
        })

        testThatRequestHasVulnerability((req, res) => {
          setCookieFunctions.insecureWithResCookieMethod('insecure', 'cookie', res)
          setCookieFunctions.insecureWithResCookieMethod('insecure2', 'cookie2', res)
        }, 'NO_HTTPONLY_COOKIE', {
          occurrences: 1,
          location: {
            path: setCookieFunctionsFilename,
            line: 4
          }
        })

        testThatRequestHasVulnerability((req, res) => {
          setCookieFunctions.insecureWithResHeaderMethod('insecure', 'cookie', res)
        }, 'NO_HTTPONLY_COOKIE', {
          occurrences: 1,
          location: {
            path: setCookieFunctionsFilename,
            line: 8
          }
        })

        testThatRequestHasVulnerability((req, res) => {
          setCookieFunctions.insecureWithResHeaderMethodWithArray('insecure', 'cookie', 'insecure2', 'cookie2', res)
        }, 'NO_HTTPONLY_COOKIE', {
          occurrences: 1,
          location: {
            path: setCookieFunctionsFilename,
            line: 12
          }
        })

        testThatRequestHasNoVulnerability((req, res) => {
          res.cookie('secure', 'cookie', { secure: true, httpOnly: true })
          res.clearCookie('deleteinsecure')
          res.header('set-cookie', 'other=secure; Secure; HttpOnly')
          res.header('set-cookie', ['other=safe; HttpOnly', 'more=safe2; Secure; HttpOnly'])
        }, 'NO_HTTPONLY_COOKIE')
      })
  })
})
