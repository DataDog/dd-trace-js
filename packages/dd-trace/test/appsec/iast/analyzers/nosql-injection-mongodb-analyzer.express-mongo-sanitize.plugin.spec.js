'use strict'

const axios = require('axios')
const { expect } = require('chai')
const { describe } = require('mocha')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { prepareTestServerForIastInExpress } = require('../utils')
const agent = require('../../../plugins/agent')
const { withVersions } = require('../../../setup/mocha')

describe('nosql injection detection in mongodb - whole feature', () => {
  // https://github.com/fiznool/express-mongo-sanitize/issues/200
  withVersions('express-mongo-sanitize', 'express', '>4.18.0 <5.0.0', expressVersion => {
    withVersions('express-mongo-sanitize', 'mongodb', mongodbVersion => {
      const mongodb = require(`../../../../../../versions/mongodb@${mongodbVersion}`)

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
        (expressApp) => {
          expressApp.get('/path/:parameter', async function (req, res) {
            await collection.find({
              key: req.params.parameter
            })
            res.end()
          })
        },
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
            testDescription: 'should have NOSQL_MONGODB_INJECTION vulnerability in $or clause',
            fn: async (req, res) => {
              await collection.find({
                key: {
                  $or: [req.query.key, 'test']
                }
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

          testThatRequestHasNoVulnerability({
            testDescription: 'should not have NOSQL_MONGODB_INJECTION vulnerability using $eq',
            fn: async (req, res) => {
              await collection.find({
                key: {
                  $eq: req.query.key
                }
              })
              res.end()
            },
            vulnerability: 'NOSQL_MONGODB_INJECTION',
            makeRequest: (done, config) => {
              axios.get(`http://localhost:${config.port}/?key=value`).catch(done)
            }
          })

          testThatRequestHasNoVulnerability({
            testDescription: 'should not have NOSQL_MONGODB_INJECTION vulnerability with modified tainted string',
            fn: async (req, res) => {
              const data = req.query.key
              // eslint-disable-next-line no-undef
              const modifiedData = _ddiast.plusOperator('modified' + data, 'modified', data)

              await collection.find({
                key: modifiedData
              })

              res.end()
            },
            vulnerability: 'NOSQL_MONGODB_INJECTION',
            makeRequest: (done, config) => {
              axios.get(`http://localhost:${config.port}/?key=value`).catch(done)
            }
          })

          testThatRequestHasNoVulnerability({
            testDescription: 'should not have NOSQL_MONGODB_INJECTION vulnerability in too deep property',
            fn: async (req, res) => {
              const deep = 11
              const obj = {}
              let next = obj

              for (let i = 0; i <= deep; i++) {
                if (i === deep) {
                  next.key = req.query.key
                  break
                }

                next.key = {}
                next = next.key
              }

              await collection.find(obj)
              res.end()
            },
            vulnerability: 'NOSQL_MONGODB_INJECTION',
            makeRequest: (done, config) => {
              axios.get(`http://localhost:${config.port}/?key=value`).catch(done)
            }
          })

          testThatRequestHasNoVulnerability({
            testDescription: 'should not have NOSQL_MONGODB_INJECTION vulnerability with path params',
            fn: function noop () {},
            vulnerability: 'NOSQL_MONGODB_INJECTION',
            makeRequest: (done, config) => {
              axios.get(`http://localhost:${config.port}/path/parameterValue`).catch(done)
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
