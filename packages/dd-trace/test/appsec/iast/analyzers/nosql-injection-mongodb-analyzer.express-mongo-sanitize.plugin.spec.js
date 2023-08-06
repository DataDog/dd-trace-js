'use strict'

const { prepareTestServerForIastInExpress } = require('../utils')
const axios = require('axios')
const agent = require('../../../plugins/agent')
describe('nosql injection detection in mongodb - whole feature', () => {
  withVersions('express', 'express', '>4.18.0', expressVersion => {
    withVersions('mongodb', 'mongodb', mongodbVersion => {
      let collection

      before(() => {
        return agent.load(['mongodb'], { client: false }, { flushInterval: 1 })
      })

      before(async () => {
        const { MongoClient } = require(`../../../../../../versions/mongodb@${mongodbVersion}`).get()
        const client = new MongoClient('mongodb://127.0.0.1:27017')
        await client.connect()

        const db = client.db('test')
        collection = db.collection('test-collection')
      })

      prepareTestServerForIastInExpress('Test without sanitization middlewares', expressVersion,
        (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
          testThatRequestHasVulnerability({
            fn: async (req, res) => {
              await collection.find({
                key: req.query.key
              })
              res.end()
            },
            vulnerability: 'NOSQL_MONGODB_INJECTION',
            makeRequest: (done, config) => {
              axios.get(`http://localhost:${config.port}/?key=value`).catch(done)
            }
          })

          testThatRequestHasNoVulnerability(async (req, res) => {
            await collection.find({
              key: 'test'
            })
            res.end()
          }, 'NOSQL_MONGODB_INJECTION')
        })

      withVersions('express-mongo-sanitize', 'express-mongo-sanitize', expressMongoSanitizeVersion => {
        prepareTestServerForIastInExpress('Test with sanitization middleware', expressVersion, (expressApp) => {
          const mongoSanitize =
            require(`../../../../../../versions/express-mongo-sanitize@${expressMongoSanitizeVersion}`).get()
          expressApp.use(mongoSanitize())
        }, (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
          testThatRequestHasNoVulnerability({
            fn: async (req, res) => {
              await collection.find({
                key: req.query.key
              })
              res.end()
            },
            vulnerability: 'NOSQL_MONGODB_INJECTION',
            makeRequest: (done, config) => {
              axios.get(`http://localhost:${config.port}/?key=value`).catch(done)
            }
          })
        })
      })
    })
  })
})
