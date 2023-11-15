'use strict'

const { prepareTestServerForIastInExpress } = require('../utils')
const axios = require('axios')
const agent = require('../../../plugins/agent')
const os = require('os')
const path = require('path')
const semver = require('semver')
const fs = require('fs')

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

      withVersions('express-mongo-sanitize', 'mquery', mqueryVersion => {
        let mquery

        const vulnerableMethodFilename = 'mquery-vulnerable-method.js'
        let client, testCollection, tmpFilePath, dbName

        before(() => {
          return agent.load(['mongodb'], { client: false }, { flushInterval: 1 })
        })

        before(async () => {
          const id = require('../../../../src/id')
          dbName = id().toString()
          const mongo = require(`../../../../../../versions/mongodb@${mongodbVersion}`).get()
          mquery = require(`../../../../../../versions/mquery@${mqueryVersion}`).get()

          client = new mongo.MongoClient(`mongodb://localhost:27017/${dbName}`, {
            useNewUrlParser: true,
            useUnifiedTopology: true
          })
          await client.connect()

          testCollection = client.db().collection('Test')

          const src = path.join(__dirname, 'resources', vulnerableMethodFilename)

          tmpFilePath = path.join(os.tmpdir(), vulnerableMethodFilename)
          try {
            fs.unlinkSync(tmpFilePath)
          } catch (e) {
            // ignore the error
          }
          fs.copyFileSync(src, tmpFilePath)
        })

        after(async () => {
          fs.unlinkSync(tmpFilePath)
          await client.close()
        })

        prepareTestServerForIastInExpress('Test with mquery', expressVersion,
          (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
            testThatRequestHasVulnerability({
              fn: async (req, res) => {
                mquery()
                  .find({
                    name: req.query.key,
                    value: [1, 2,
                      'value',
                      false, req.query.key]
                  })
                  .collection(testCollection)
                  .then(() => {
                    res.end()
                  }).catch((err) => {
                    res.end()
                  })
              },
              vulnerability: 'NOSQL_MONGODB_INJECTION',
              makeRequest: (done, config) => {
                axios.get(`http://localhost:${config.port}/?key=value`).catch(done)
              }
            })

            testThatRequestHasVulnerability({
              testDescription: 'should have NOSQL_MONGODB_INJECTION vulnerability in correct file and line [find]',
              fn: async (req, res) => {
                const filter = {
                  name: {
                    child: [req.query.key]
                  }
                }
                require(tmpFilePath).vulnerableFind(testCollection, filter, () => {
                  res.end()
                })
              },
              vulnerability: 'NOSQL_MONGODB_INJECTION',
              makeRequest: (done, config) => {
                axios.get(`http://localhost:${config.port}/?key=value`).catch(done)
              },
              occurrences: {
                occurrences: 1,
                location: {
                  path: vulnerableMethodFilename,
                  line: 9
                }
              }
            })

            testThatRequestHasVulnerability({
              testDescription: 'should have NOSQL_MONGODB_INJECTION vulnerability in correct file and line [findOne]',
              fn: async (req, res) => {
                const filter = {
                  name: {
                    child: [req.query.key]
                  }
                }
                require(tmpFilePath).vulnerableFindOne(testCollection, filter, () => {
                  res.end()
                })
              },
              vulnerability: 'NOSQL_MONGODB_INJECTION',
              makeRequest: (done, config) => {
                axios.get(`http://localhost:${config.port}/?key=value`).catch(done)
              },
              occurrences: {
                occurrences: 1,
                location: {
                  path: vulnerableMethodFilename,
                  line: 16
                }
              }
            })

            testThatRequestHasNoVulnerability(async (req, res) => {
              mquery(testCollection)
                .find({
                  name: 'test'
                }).then(() => {
                  res.end()
                })
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
                const filter = {
                  name: {
                    child: [req.query.key]
                  }
                }
                require(tmpFilePath).vulnerableFindOne(testCollection, filter, () => {
                  res.end()
                })
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
})
