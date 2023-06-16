'use strict'

const { prepareTestServerForIastInExpress } = require('../utils')
const axios = require('axios')

function noop () {}
describe('Taint tracking plugin sources express tests', () => {
  withVersions('express', 'express', '>=4.8.0', version => {
    prepareTestServerForIastInExpress('in express', version,
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
          }, 'COMMAND_INJECTION', 1, () => {
          }, makePostRequest)
        })

        describe('tainted query param', () => {
          function makeRequestWithParams (done) {
            axios.get(`http://localhost:${config.port}/?command=echo`).catch(done)
          }

          testThatRequestHasVulnerability((req) => {
            const childProcess = require('child_process')
            childProcess.exec(req.query.command, noop)
          }, 'COMMAND_INJECTION', 1, () => {
          }, makeRequestWithParams)
        })

        describe('tainted header', () => {
          function makeRequestWithHeaders (done) {
            axios.get(`http://localhost:${config.port}/`, {
              headers: {
                'x-iast-test-command': 'echo 1'
              }
            }).catch(done)
          }

          testThatRequestHasVulnerability((req) => {
            const childProcess = require('child_process')
            childProcess.exec(req.headers['x-iast-test-command'], noop)
          }, 'COMMAND_INJECTION', 1, () => {
          }, makeRequestWithHeaders)
        })
      }
    )
  })
})
