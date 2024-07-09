'use strict'

const { prepareTestServerForIastInExpress } = require('../utils')
const axios = require('axios')

describe('Eval injection vulnerability', () => {
  withVersions('express', 'express', version => {
    prepareTestServerForIastInExpress('in express', version,
      (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
        testThatRequestHasVulnerability({
          fn: (req, res) => {
            // eslint-disable-next-line no-eval
            res.send('' + eval(req.query.script))
          },
          vulnerability: 'EVAL_INJECTION',
          makeRequest: (done, config) => {
            axios.get(`http://localhost:${config.port}/?script=1%2B2`).catch(done)
          }
        })

        testThatRequestHasNoVulnerability((req, res) => {
          // eslint-disable-next-line no-eval
          res.send('' + eval('1 + 2'))
        }, 'EVAL_INJECTION')
      })
  })
})
