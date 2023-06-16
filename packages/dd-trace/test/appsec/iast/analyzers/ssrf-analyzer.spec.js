'use strict'

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
                testThatRequestHasVulnerability(() => {
                  const store = storage.getStore()
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
              })

              describe('with options', () => {
                testThatRequestHasVulnerability(() => {
                  const store = storage.getStore()
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
          const store = storage.getStore()
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
