'use strict'

const { prepareTestServerForIastInExpress } = require('../utils')
const axios = require('axios')
const agent = require('../../../plugins/agent')
const semver = require('semver')
const os = require('os')
const path = require('path')
const fs = require('fs')

describe('nosql injection detection in mongodb - whole feature', () => {
  withVersions('express', 'express', '>4.18.0', expressVersion => {
    withVersions('mongoose', 'mongoose', '>4.0.0', mongooseVersion => {
      const vulnerableMethodFilename = 'mongoose-vulnerable-method.js'
      let mongoose, Test, tmpFilePath

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

        const src = path.join(__dirname, 'resources', vulnerableMethodFilename)
        tmpFilePath = path.join(os.tmpdir(), vulnerableMethodFilename)
        try {
          fs.unlinkSync(tmpFilePath)
        } catch (e) {
          // ignore the error
        }
        fs.copyFileSync(src, tmpFilePath)
      })


      after(() => {
        fs.unlinkSync(tmpFilePath)
        return mongoose.disconnect()
      })

      prepareTestServerForIastInExpress('Test with mongoose', expressVersion,
        (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
          testThatRequestHasVulnerability({
            fn: async (req, res) => {
              Test.find({
                name: req.query.key,
                value: [1, 2,
                  'value',
                  false, req.query.key ]
              }).then(() => {
                res.end()
              })
            },
            vulnerability: 'NOSQL_MONGODB_INJECTION',
            makeRequest: (done, config) => {
              axios.get(`http://localhost:${config.port}/?key=value`).catch(done)
            }
          })

          testThatRequestHasVulnerability({
            fn: async (req, res) => {
              Test.find({
                name: {
                  child: [req.query.key]
                }
              }).then(() => {
                res.end()
              })
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
                name: {
                  child: [req.query.key]
                }
              }
              require(tmpFilePath)(Test, filter, () => {
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
                line: 4
              }
            }
          })

          if (semver.satisfies(mongooseVersion, '>=6')) {
            testThatRequestHasNoVulnerability({
              testDescription: 'should not have NOSQL_MONGODB_INJECTION vulnerability with mongoose.sanitizeFilter',
              fn: async (req, res) => {
                const filter = mongoose.sanitizeFilter({
                  name: {
                    child: [req.query.key]
                  }
                })
                Test.find(filter).then(() => {
                  res.end()
                })
              },
              vulnerability: 'NOSQL_MONGODB_INJECTION',
              makeRequest: (done, config) => {
                axios.get(`http://localhost:${config.port}/?key=value`).catch(done)
              }
            })
          }

          testThatRequestHasNoVulnerability(async (req, res) => {
            Test.find({
              name: 'test'
            }).then(() => {
              res.end()
            })
          }, 'NOSQL_MONGODB_INJECTION')
        })
    })
  })
})
