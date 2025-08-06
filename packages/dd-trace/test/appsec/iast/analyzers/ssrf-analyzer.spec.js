'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const axios = require('axios')
const { prepareTestServerForIast } = require('../utils')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString } = require('../../../../src/appsec/iast/taint-tracking/operations')

describe('ssrf analyzer', () => {
  prepareTestServerForIast('ssrf',
    (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
      ['http', 'https'].forEach(pluginName => {
        function executeHttpGet (http, url) {
          return new Promise((resolve, reject) => {
            const clientRequest = http.get(url, () => {
              if (!resolved) {
                resolved = true
                resolve()
              }
            })
            let resolved = false

            clientRequest.on('error', () => {
              if (!resolved) {
                resolved = true
                resolve()
              }
            })

            clientRequest.on('close', () => {
              if (!resolved) {
                resolved = true
                resolve()
              }
            })

            clientRequest.destroy()
          })
        }

        function executeHttpRequest (http, url) {
          return new Promise((resolve) => {
            const clientRequest = http.request(url, (res) => {
              if (!resolved) {
                resolved = true
                resolve()
              }
            })
            let resolved = false

            clientRequest.on('error', () => {
              if (!resolved) {
                resolved = true
                resolve()
              }
            })

            clientRequest.on('close', () => {
              if (!resolved) {
                resolved = true
                resolve()
              }
            })

            clientRequest.destroy()
          })
        }

        describe(pluginName, () => {
          [
            {
              httpMethodName: 'get',
              methodToExecute: executeHttpGet
            },
            {
              httpMethodName: 'request',
              methodToExecute: executeHttpRequest
            }
          ].forEach(requestMethodData => {
            describe(requestMethodData.httpMethodName, () => {
              describe('with url', () => {
                const taintTrackingUtilsFilename = 'taint-tracking-utils.js'
                let taintTrackingUtilsFilePath

                before(() => {
                  taintTrackingUtilsFilePath = path.join(os.tmpdir(), taintTrackingUtilsFilename)

                  fs.copyFileSync(
                    path.join(__dirname, 'resources', taintTrackingUtilsFilename),
                    taintTrackingUtilsFilePath
                  )
                })

                after(() => {
                  fs.unlinkSync(taintTrackingUtilsFilePath)
                })

                testThatRequestHasVulnerability(() => {
                  const store = storage('legacy').getStore()
                  const iastContext = iastContextFunctions.getIastContext(store)

                  const url = newTaintedString(iastContext, pluginName + '://www.google.com', 'param', 'Request')
                  const https = require(pluginName)

                  return requestMethodData.methodToExecute(https, url)
                }, 'SSRF')

                testThatRequestHasNoVulnerability(() => {
                  const url = pluginName + '://www.google.com'
                  const https = require(pluginName)
                  return requestMethodData.methodToExecute(https, url)
                }, 'SSRF')

                testThatRequestHasNoVulnerability((req, res) => {
                  const utils = require(taintTrackingUtilsFilePath)

                  const hash = req.headers.hash
                  let url = pluginName + '://www.google.com/#'
                  url = utils.add(url, hash)
                  const https = require(pluginName)
                  requestMethodData.methodToExecute(https, url)
                  res.end()
                }, 'SSRF', (done, config) => {
                  axios.get(`http://localhost:${config.port}`, {
                    headers: {
                      hash: 'taintedHash'
                    }
                  })
                }, 'should not have SSRF vulnerability when the tainted value is after #')
              })

              describe('with options', () => {
                testThatRequestHasVulnerability(() => {
                  const store = storage('legacy').getStore()
                  const iastContext = iastContextFunctions.getIastContext(store)

                  const host = newTaintedString(iastContext, 'www.google.com', 'param', 'Request')
                  const options = {
                    host,
                    protocol: `${pluginName}:`
                  }

                  return requestMethodData.methodToExecute(require(pluginName), options)
                }, 'SSRF')

                testThatRequestHasNoVulnerability(() => {
                  const host = 'www.google.com'
                  const options = {
                    host,
                    protocol: `${pluginName}:`
                  }

                  return requestMethodData.methodToExecute(require(pluginName), options)
                }, 'SSRF')
              })
            })
          })
        })
      })

      describe('http2', () => {
        testThatRequestHasVulnerability(() => {
          const store = storage('legacy').getStore()
          const iastContext = iastContextFunctions.getIastContext(store)

          const url = newTaintedString(iastContext, 'http://www.datadoghq.com', 'param', 'Request')
          const http2 = require('http2')

          const session = http2.connect(url)

          session.destroy()
        }, 'SSRF')

        testThatRequestHasNoVulnerability(() => {
          const url = 'http://www.datadoghq.com'
          const http2 = require('http2')

          const session = http2.connect(url)

          session.destroy()
        }, 'SSRF')
      })
    })
})
