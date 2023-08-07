'use strict'

const { prepareTestServerForIastInExpress } = require('../utils')
const axios = require('axios')
const agent = require('../../../plugins/agent')
const path = require('path')
const os = require('os')
const fs = require('fs')
describe('nosql injection detection in mongodb - whole feature', () => {
  withVersions('express', 'express', '>4.18.0', expressVersion => {
    withVersions('mongodb', 'mongodb', mongodbVersion => {
      const vulnerableMethodFilename = 'mongodb-vulnerable-method.js'
      let collection, tmpFilePath

      before(() => {
        return agent.load(['mongodb'], { client: false }, { flushInterval: 1 })
      })

      before(async () => {
        const { MongoClient } = require(`../../../../../../versions/mongodb@${mongodbVersion}`).get()
        const client = new MongoClient('mongodb://127.0.0.1:27017')
        await client.connect()

        const db = client.db('test')
        collection = db.collection('test-collection')

        const src = path.join(__dirname, 'resources', vulnerableMethodFilename)
        tmpFilePath = path.join(os.tmpdir(), vulnerableMethodFilename)
        try {
          fs.unlinkSync(tmpFilePath)
        } catch (e) {
          // ignore the error
        }
        fs.copyFileSync(src, tmpFilePath)
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

          testThatRequestHasVulnerability({
            testDescription: 'should have NOSQL_MONGODB_INJECTION vulnerability in correct file and line',
            fn: async (req, res) => {
              const filter = {
                key: req.query.key
              }
              await require(tmpFilePath)(collection, filter)
              res.end()
            },
            vulnerability: 'NOSQL_MONGODB_INJECTION',
            makeRequest: (done, config) => {
              axios.get(`http://localhost:${config.port}/?key=value`).catch(done)
            },
            occurrences: {
              occurrences: 1,
              location: {
                path: vulnerableMethodFilename,
                line: 5
              }
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
