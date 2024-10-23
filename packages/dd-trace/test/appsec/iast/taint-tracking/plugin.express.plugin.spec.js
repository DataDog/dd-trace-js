'use strict'

const { prepareTestServerForIastInExpress } = require('../utils')
const axios = require('axios')

function noop () {}

describe('Taint tracking plugin sources express tests', () => {
  withVersions('express', 'express', '>=4.8.0', version => {
    prepareTestServerForIastInExpress('in express', version,
      (expressApp, listener) => {
        const multer = require('../../../../../../versions/multer').get()
        const uploadToMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200000 } })
        expressApp.post('/multipart', uploadToMemory.single('file'), listener)
      },

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

        describe('tainted multipart body', () => {
          function makeMultipartPostRequest (done) {
            const formData = new FormData()
            formData.append('command', 'echo 1')
            axios.post(`http://localhost:${config.port}/multipart`, formData).catch(done)
          }

          testThatRequestHasVulnerability((req) => {
            const childProcess = require('child_process')
            childProcess.exec(req.body.command, noop)
          }, 'COMMAND_INJECTION', 1, noop, makeMultipartPostRequest)
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
      }
    )
  })
})
