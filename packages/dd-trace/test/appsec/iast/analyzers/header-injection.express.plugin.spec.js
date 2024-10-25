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

        testThatRequestHasVulnerability({
          testDescription: 'should have HEADER_INJECTION vulnerability ' +
            'when the header value is an array with tainted string',
          fn: (req, res) => {
            setHeaderFunction('custom', ['not_tainted', req.body.test], res)
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
          testDescription: 'should not have HEADER_INJECTION vulnerability ' +
            'when the header value an array without tainteds',
          fn: (req, res) => {
            setHeaderFunction('custom', ['not tainted string 1', 'not tainted string 2'], res)
          },
          vulnerability: 'HEADER_INJECTION'
        })

        testThatRequestHasNoVulnerability({
          testDescription: 'should not have HEADER_INJECTION vulnerability ' +
            'when is the header same header',
          fn: (req, res) => {
            setHeaderFunction('testheader', req.get('testheader'), res)
          },
          vulnerability: 'HEADER_INJECTION',
          makeRequest: (done, config) => {
            return axios.get(`http://localhost:${config.port}/`, {
              headers: {
                testheader: 'headerValue'
              }
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
          testDescription: 'should not have HEADER_INJECTION vulnerability when the header is "location"',
          fn: (req, res) => {
            setHeaderFunction('location', req.body.test, res)
          },
          vulnerability: 'HEADER_INJECTION',
          makeRequest: (done, config) => {
            return axios.post(`http://localhost:${config.port}/`, {
              test: 'https://www.datadoghq.com'
            }).catch(done)
          }
        })

        testThatRequestHasNoVulnerability({
          testDescription: 'should not have HEADER_INJECTION vulnerability when the header is "Sec-WebSocket-Location"',
          fn: (req, res) => {
            setHeaderFunction('Sec-WebSocket-Location', req.body.test, res)
          },
          vulnerability: 'HEADER_INJECTION',
          makeRequest: (done, config) => {
            return axios.post(`http://localhost:${config.port}/`, {
              test: 'https://www.datadoghq.com'
            }).catch(done)
          }
        })

        testThatRequestHasNoVulnerability({
          testDescription: 'should not have HEADER_INJECTION vulnerability when the header is "Sec-WebSocket-Accept"',
          fn: (req, res) => {
            setHeaderFunction('Sec-WebSocket-Accept', req.body.test, res)
          },
          vulnerability: 'HEADER_INJECTION',
          makeRequest: (done, config) => {
            return axios.post(`http://localhost:${config.port}/`, {
              test: 'https://www.datadoghq.com'
            }).catch(done)
          }
        })

        testThatRequestHasNoVulnerability({
          testDescription: 'should not have HEADER_INJECTION vulnerability when the header is "Upgrade"',
          fn: (req, res) => {
            setHeaderFunction('Upgrade', req.body.test, res)
          },
          vulnerability: 'HEADER_INJECTION',
          makeRequest: (done, config) => {
            return axios.post(`http://localhost:${config.port}/`, {
              test: 'https://www.datadoghq.com'
            }).catch(done)
          }
        })

        testThatRequestHasNoVulnerability({
          testDescription: 'should not have HEADER_INJECTION vulnerability when the header is "Connection"',
          fn: (req, res) => {
            setHeaderFunction('Upgrade', req.body.test, res)
          },
          vulnerability: 'HEADER_INJECTION',
          makeRequest: (done, config) => {
            return axios.post(`http://localhost:${config.port}/`, {
              test: 'https://www.datadoghq.com'
            }).catch(done)
          }
        })

        testThatRequestHasNoVulnerability({
          testDescription: 'should not have HEADER_INJECTION vulnerability ' +
            'when the header is "access-control-allow-origin" and the origin is a header',
          fn: (req, res) => {
            setHeaderFunction('access-control-allow-origin', req.headers.testheader, res)
          },
          vulnerability: 'HEADER_INJECTION',
          makeRequest: (done, config) => {
            return axios.get(`http://localhost:${config.port}/`, {
              headers: {
                testheader: 'headerValue'
              }
            }).catch(done)
          }
        })

        testThatRequestHasVulnerability({
          testDescription: 'should have HEADER_INJECTION vulnerability ' +
            'when the header is "access-control-allow-origin" and the origin is not a header',
          fn: (req, res) => {
            setHeaderFunction('access-control-allow-origin', req.body.test, res)
          },
          vulnerability: 'HEADER_INJECTION',
          makeRequest: (done, config) => {
            return axios.post(`http://localhost:${config.port}/`, {
              test: 'https://www.datadoghq.com'
            }, {
              headers: {
                testheader: 'headerValue'
              }
            }).catch(done)
          }
        })

        testThatRequestHasNoVulnerability({
          testDescription: 'should not have HEADER_INJECTION vulnerability ' +
            'when the header is "set-cookie" and the origin is a cookie',
          fn: (req, res) => {
            setHeaderFunction('set-cookie', req.cookies.cookie1, res)
          },
          vulnerability: 'HEADER_INJECTION',
          makeRequest: (done, config) => {
            return axios.get(`http://localhost:${config.port}/`, {
              headers: {
                Cookie: 'cookie1=value'
              }
            }).catch(done)
          }
        })

        testThatRequestHasVulnerability({
          testDescription: 'should have HEADER_INJECTION vulnerability when ' +
            'the header is "access-control-allow-origin" and the origin is not a header',
          fn: (req, res) => {
            setHeaderFunction('set-cookie', req.body.test, res)
          },
          vulnerability: 'HEADER_INJECTION',
          makeRequest: (done, config) => {
            return axios.post(`http://localhost:${config.port}/`, {
              test: 'key=value'
            }, {
              headers: {
                testheader: 'headerValue'
              }
            }).catch(done)
          }
        })

        testThatRequestHasNoVulnerability({
          fn: (req, res) => {
            setHeaderFunction('Access-Control-Allow-Origin', req.headers.origin, res)
            setHeaderFunction('Access-Control-Allow-Headers', req.headers['access-control-request-headers'], res)
            setHeaderFunction('Access-Control-Allow-Methods', req.headers['access-control-request-methods'], res)
          },
          testDescription: 'Should not have vulnerability with CORS headers',
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
            return axios.options(`http://localhost:${config.port}/`, {
              headers: {
                origin: 'http://custom-origin',
                'Access-Control-Request-Headers': 'TestHeader',
                'Access-Control-Request-Methods': 'GET'
              }
            }).catch(done)
          }
        })
      })
  })
})
