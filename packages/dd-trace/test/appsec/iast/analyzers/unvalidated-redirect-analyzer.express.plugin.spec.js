'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const { UNVALIDATED_REDIRECT } = require('../../../../src/appsec/iast/vulnerabilities')
const { prepareTestServerForIastInExpress } = require('../utils')
const { withVersions } = require('../../../setup/mocha')
const Axios = require('axios')

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

  function getAxiosInstance (config) {
    return Axios.create({
      baseURL: `http://localhost:${config.port}`
    })
  }

  withVersions('express', 'express', version => {
    prepareTestServerForIastInExpress('in express', version,
      (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
        testThatRequestHasVulnerability((req, res) => {
          const location = req.query.location
          redirectFunctions.insecureWithResHeaderMethod('location', location, res)
        }, UNVALIDATED_REDIRECT, {
          occurrences: 1,
          location: {
            path: redirectFunctionsFilename,
            line: 4
          }
        }, null, (done, config) => {
          getAxiosInstance(config).get('/?location=https://app.com?id=tron').catch(done)
        })

        testThatRequestHasVulnerability((req, res) => {
          redirectFunctions.insecureWithResRedirectMethod(req.query.location, res)
        }, UNVALIDATED_REDIRECT, {
          occurrences: 1,
          location: {
            path: redirectFunctionsFilename,
            line: 8
          }
        }, null, (done, config) => {
          getAxiosInstance(config).get('/?location=http://user@app.com/').catch(done)
        })

        testThatRequestHasVulnerability((req, res) => {
          redirectFunctions.insecureWithResLocationMethod(req.query.location, res)
        }, UNVALIDATED_REDIRECT, {
          occurrences: 1,
          location: {
            path: redirectFunctionsFilename,
            line: 12
          }
        }, null, (done, config) => {
          getAxiosInstance(config).get('/?location=http://user@app.com/').catch(done)
        })

        testThatRequestHasVulnerability((req, res) => {
          redirectFunctions.insecureWithResLocationMethod(req.body.location, res)
        }, UNVALIDATED_REDIRECT, {
          occurrences: 1,
          location: {
            path: redirectFunctionsFilename,
            line: 12
          }
        }, null, (done, config) => {
          getAxiosInstance(config).post('', {
            location: 'http://user@app.com/'
          }).catch(done)
        })

        testThatRequestHasNoVulnerability((req, res) => {
          res.header('X-test', req.query.location)
        }, UNVALIDATED_REDIRECT, (done, config) => {
          getAxiosInstance(config).get('/?location=http://user@app.com/').catch(done)
        })

        testThatRequestHasNoVulnerability((req, res) => {
          redirectFunctions.insecureWithResHeaderMethod('location', 'http://user@app.com/', res)
        }, UNVALIDATED_REDIRECT)

        testThatRequestHasNoVulnerability((req, res) => {
          redirectFunctions.insecureWithResLocationMethod(req.headers.redirectlocation, res)
        }, UNVALIDATED_REDIRECT, (done, config) => {
          getAxiosInstance(config).get('', {
            headers: {
              redirectlocation: 'http://user@app.com/'
            }
          }).catch(done)
        })
      })
  })
})
