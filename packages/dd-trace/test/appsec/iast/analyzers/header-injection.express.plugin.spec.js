'use strict'

const axios = require('axios')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { prepareTestServerForIastInExpress } = require('../utils')

describe('Header injection vulnerability', () => {
  let setHeaderFunction
  const setHeaderFunctionFilename = 'set-header-function.js'
  const setHeaderFunctionPath = path.join(os.tmpdir(), setHeaderFunctionFilename)

  before(() => {
    fs.copyFileSync(path.join(__dirname, 'resources', 'set-header-function.js'), setHeaderFunctionPath)
    setHeaderFunction = require(setHeaderFunctionPath).setHeader
  })

  after(() => {
    fs.unlinkSync(setHeaderFunctionPath)
  })

  withVersions('express', 'express', version => {
    prepareTestServerForIastInExpress('in express', version,
      (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
        testThatRequestHasVulnerability({
          fn: (req, res) => {
            setHeaderFunction('custom', req.body.test, res)
          },
          vulnerability: 'HEADER_INJECTION',
          occurrencesAndLocation: {
            occurrences: 1,
            location: {
              path: setHeaderFunctionFilename,
              line: 4
            }
          },
          cb: (headerInjectionVulnerabilities) => {
            const evidenceString = headerInjectionVulnerabilities[0].evidence.valueParts
              .map(part => part.value).join('')
            expect(evidenceString).to.be.equal('custom: value')
          },
          makeRequest: (done, config) => {
            return axios.post(`http://localhost:${config.port}/`, {
              test: 'value'
            }).catch(done)
          }
        })

        testThatRequestHasNoVulnerability({
          testDescription: 'should not have HEADER_INJECTION vulnerability when the header value is not tainted',
          fn: (req, res) => {
            setHeaderFunction('custom', 'not tainted string', res)
          },
          vulnerability: 'HEADER_INJECTION'
        })

        testThatRequestHasNoVulnerability({
          testDescription: 'should not have HEADER_INJECTION vulnerability when the header is location',
          fn: (req, res) => {
            setHeaderFunction('location', 'not tainted string', res)
          },
          vulnerability: 'HEADER_INJECTION',
          makeRequest: (done, config) => {
            return axios.post(`http://localhost:${config.port}/`, {
              test: 'https://www.datadoghq.com'
            }).catch(done)
          }
        })
      })
  })
})
