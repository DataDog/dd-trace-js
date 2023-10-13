'use strict'

const axios = require('axios')
const fs = require('fs')
const os = require('os')
const path = require('path')
const semver = require('semver')
const { prepareTestServerForIastInExpress } = require('../utils')
const agent = require('../../../plugins/agent')

describe('nosql injection detection in mongodb - whole feature', () => {
  withVersions('express', 'express', '>4.18.0', expressVersion => {
    withVersions('mongodb', 'mongodb', mongodbVersion => {
      const mongodb = require(`../../../../../../versions/mongodb@${mongodbVersion}`)

      const satisfiesNodeVersionForMongo3and4 =
        (semver.satisfies(process.version, '<14.20.1') && semver.satisfies(mongodb.version(), '>=3.3 <5'))
      const satisfiesNodeVersionForMongo5 =
        (semver.satisfies(process.version, '>=14.20.1 <16.20.1') && semver.satisfies(mongodb.version(), '5'))
      const satisfiesNodeVersionForMongo6 =
        (semver.satisfies(process.version, '>=16.20.1') && semver.satisfies(mongodb.version(), '>=6'))

      if (!satisfiesNodeVersionForMongo3and4 && !satisfiesNodeVersionForMongo5 && !satisfiesNodeVersionForMongo6) return

      const vulnerableMethodFilename = 'mongodb-vulnerable-method.js'
      let collection, tmpFilePath

      before(() => {
        return agent.load(['mongodb'], { client: false }, { flushInterval: 1 })
      })

      before(async () => {
        const { MongoClient } = mongodb.get()
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
            },
            cb: function (vulnerabilities) {
              const vulnerability = vulnerabilities[0]
              let someRedacted = false
              vulnerability.evidence.valueParts.forEach(valuePart => {
                if (valuePart.redacted) {
                  someRedacted = true
                }
              })

              expect(someRedacted).to.be.true
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

      prepareTestServerForIastInExpress('Test without sanitization middlewares and without redaction', expressVersion,
        undefined, (testThatRequestHasVulnerability) => {
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
            },
            cb: function (vulnerabilities) {
              const vulnerability = vulnerabilities[0]
              let someRedacted = false
              vulnerability.evidence.valueParts.forEach(valuePart => {
                if (valuePart.redacted) {
                  someRedacted = true
                }
              })

              expect(someRedacted).to.be.false
            }
          })
        }, {
          enabled: true,
          requestSampling: 100,
          maxConcurrentRequests: 100,
          maxContextOperations: 100,
          redactionEnabled: false
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
