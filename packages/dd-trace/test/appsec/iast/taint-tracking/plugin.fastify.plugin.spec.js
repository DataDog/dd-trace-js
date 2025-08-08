'use strict'

const { prepareTestServerForIastInFastify } = require('../utils')
const { withVersions } = require('../../../setup/mocha')
const axios = require('axios')
const { URL } = require('url')

function noop () {}

describe('Taint tracking plugin sources fastify tests', () => {
  withVersions('fastify', 'fastify', '>=2', version => {
    prepareTestServerForIastInFastify('in fastify', version,
      (testThatRequestHasVulnerability, _, config) => {
        describe('tainted body', () => {
          function makePostRequest (done) {
            axios.post(`http://localhost:${config.port}/`, {
              command: 'echo 1'
            }).catch(done)
          }

          testThatRequestHasVulnerability((req) => {
            const childProcess = require('child_process')
            childProcess.exec(req.body.command, noop)
          }, 'COMMAND_INJECTION', 1, noop, makePostRequest)
        })

        describe('tainted query param', () => {
          function makeRequestWithQueryParam (done) {
            axios.get(`http://localhost:${config.port}/?command=echo`).catch(done)
          }

          testThatRequestHasVulnerability((req) => {
            const childProcess = require('child_process')
            childProcess.exec(req.query.command, noop)
          }, 'COMMAND_INJECTION', 1, noop, makeRequestWithQueryParam)
        })

        describe('tainted header', () => {
          function makeRequestWithHeader (done) {
            axios.get(`http://localhost:${config.port}/`, {
              headers: {
                'x-iast-test-command': 'echo 1'
              }
            }).catch(done)
          }

          testThatRequestHasVulnerability((req) => {
            const childProcess = require('child_process')
            childProcess.exec(req.headers['x-iast-test-command'], noop)
          }, 'COMMAND_INJECTION', 1, noop, makeRequestWithHeader)
        })

        describe('url parse taint tracking', () => {
          function makePostRequest (done) {
            axios.post(`http://localhost:${config.port}/`, {
              url: 'http://www.datadoghq.com/'
            }).catch(done)
          }

          testThatRequestHasVulnerability(
            {
              fn: (req) => {
                // eslint-disable-next-line n/no-deprecated-api
                const { parse } = require('url')
                const url = parse(req.body.url)

                const childProcess = require('child_process')
                childProcess.exec(url.host, noop)
              },
              vulnerability: 'COMMAND_INJECTION',
              occurrences: 1,
              cb: noop,
              makeRequest: makePostRequest,
              testDescription: 'should detect vulnerability when tainted is coming from url.parse'
            })

          testThatRequestHasVulnerability(
            {
              fn: (req) => {
                const { URL } = require('url')
                const url = new URL(req.body.url)

                const childProcess = require('child_process')
                childProcess.exec(url.host, noop)
              },
              vulnerability: 'COMMAND_INJECTION',
              occurrences: 1,
              cb: noop,
              makeRequest: makePostRequest,
              testDescription: 'should detect vulnerability when tainted is coming from new url.URL input'
            })

          testThatRequestHasVulnerability(
            {
              fn: (req) => {
                const { URL } = require('url')
                const url = new URL('/path', req.body.url)

                const childProcess = require('child_process')
                childProcess.exec(url.host, noop)
              },
              vulnerability: 'COMMAND_INJECTION',
              occurrences: 1,
              cb: noop,
              makeRequest: makePostRequest,
              testDescription: 'should detect vulnerability when tainted is coming from new url.URL base'
            })

          if (URL.parse) {
            testThatRequestHasVulnerability(
              {
                fn: (req) => {
                  const { URL } = require('url')
                  const url = URL.parse(req.body.url)
                  const childProcess = require('child_process')
                  childProcess.exec(url.host, noop)
                },
                vulnerability: 'COMMAND_INJECTION',
                occurrences: 1,
                cb: noop,
                makeRequest: makePostRequest,
                testDescription: 'should detect vulnerability when tainted is coming from url.URL.parse input'
              })

            testThatRequestHasVulnerability(
              {
                fn: (req) => {
                  const { URL } = require('url')
                  const url = URL.parse('/path', req.body.url)
                  const childProcess = require('child_process')
                  childProcess.exec(url.host, noop)
                },
                vulnerability: 'COMMAND_INJECTION',
                occurrences: 1,
                cb: noop,
                makeRequest: makePostRequest,
                testDescription: 'should detect vulnerability when tainted is coming from url.URL.parse base'
              })
          }
        })

        describe('tainted path parameters', () => {
          function makeRequestWithPathParam (done) {
            axios.get(`http://localhost:${config.port}/?id=malicious-path`).catch(done)
          }

          testThatRequestHasVulnerability((req) => {
            const childProcess = require('child_process')
            childProcess.exec(req.query.id, noop)
          }, 'COMMAND_INJECTION', 1, noop, makeRequestWithPathParam)
        })
      }
    )
  })
})
