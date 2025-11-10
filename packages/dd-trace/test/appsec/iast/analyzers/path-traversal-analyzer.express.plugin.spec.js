'use strict'

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const axios = require('axios')

const { prepareTestServerForIastInExpress } = require('../utils')
const { withVersions } = require('../../../setup/mocha')

describe('Path traversal analyzer', () => {
  let renderFunctionPath
  before(() => {
    renderFunctionPath = path.join(os.tmpdir(), 'render-function.js')
    fs.copyFileSync(
      path.join(__dirname, 'resources', 'render-function.js'),
      renderFunctionPath
    )
  })

  after(() => {
    fs.unlinkSync(renderFunctionPath)
  })

  withVersions('express', 'express', version => {
    prepareTestServerForIastInExpress('in express', version,
      (expressApp, listener) => {
        expressApp.set('view engine', 'ejs')
        expressApp.set('views', path.join(__dirname, 'resources'))
      },
      (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
        testThatRequestHasVulnerability(
          {
            fn: (req, res) => {
              require(renderFunctionPath)(res, req.query.file)
              return true
            },
            vulnerability: 'PATH_TRAVERSAL',
            occurrences: 1,
            makeRequest: (done, config) => {
              axios.get(`http://localhost:${config.port}/?file=template`)
                .catch(done)
            }
          })

        testThatRequestHasNoVulnerability(
          {
            fn: (req, res) => {
              require(renderFunctionPath)(res, 'template')
              return true
            },
            vulnerability: 'PATH_TRAVERSAL',
            makeRequest: (done, config) => {
              axios.get(`http://localhost:${config.port}/?file=template`)
                .catch(done)
            }
          })
      })
  })
})
