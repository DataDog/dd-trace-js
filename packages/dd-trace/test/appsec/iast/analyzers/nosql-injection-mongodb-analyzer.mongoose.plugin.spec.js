'use strict'

const { prepareTestServerForIastInExpress } = require('../utils')
const axios = require('axios')
const agent = require('../../../plugins/agent')
describe('nosql injection detection in mongodb - whole feature', () => {
  withVersions('express', 'express', '>4.18.0', expressVersion => {
    withVersions('mongoose', 'mongoose', '>4.0.0', mongooseVersion => {
      let mongoose, Test

      before(() => {
        return agent.load(['mongoose'])
      })

      before(async () => {
        const id = require('../../../../../dd-trace/src/id')
        const dbName = id().toString()
        mongoose = require(`../../../../../../versions/mongoose@${mongooseVersion}`).get()

        mongoose.connect(`mongodb://localhost:27017/${dbName}`, {
          useNewUrlParser: true,
          useUnifiedTopology: true
        })

        Test = mongoose.model('Test', { name: String })
      })

      after(() => {
        return mongoose.disconnect()
      })

      prepareTestServerForIastInExpress('Test without sanitization middlewares', expressVersion,
        (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
          testThatRequestHasVulnerability({
            fn: async (req, res) => {
              Test.find({
                name: req.query.key
              }).then(() => {
                res.end()
              })
            },
            vulnerability: 'NO_SQL_MONGODB_INJECTION',
            makeRequest: (done, config) => {
              axios.get(`http://localhost:${config.port}/?key=value`).catch(done)
            }
          })

          testThatRequestHasNoVulnerability(async (req, res) => {
            Test.find({
              name: 'test'
            }).then(() => {
              res.end()
            })
          }, 'NO_SQL_MONGODB_INJECTION')
        })
    })
  })
})
