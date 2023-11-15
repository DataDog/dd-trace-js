'use strict'

const { prepareTestServerForIastInExpress } = require('../utils')
const axios = require('axios')
const agent = require('../../../plugins/agent')
const semver = require('semver')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { NODE_MAJOR } = require('../../../../../../version')

describe('nosql injection detection in mongodb - whole feature', () => {
  withVersions('express', 'express', '>4.18.0', expressVersion => {
    withVersions('mongoose', 'mongoose', '>=5.0.0', mongooseVersion => {
      const specificMongooseVersion = require(`../../../../../../versions/mongoose@${mongooseVersion}`).version()
      if (NODE_MAJOR === 14 && semver.satisfies(specificMongooseVersion, '>=8')) return

      const vulnerableMethodFilename = 'mquery-vulnerable-method.js'
      let mongoose, Test, tmpFilePath, dbName

      before(() => {
        return agent.load(['mongoose'])
      })

      before(async () => {
        const id = require('../../../../src/id')
        dbName = id().toString()
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

      withVersions('mongoose', 'mquery', mqueryVersion => {
        const mquery = require(`../../../../../../versions/mquery@${mqueryVersion}`).get()

        prepareTestServerForIastInExpress('Test with mquery', expressVersion,
          (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
            // testThatRequestHasVulnerability({
            //   fn: async (req, res) => {
            //     mquery()
            //       .find({
            //         name: req.query.key,
            //         value: [1, 2,
            //           'value',
            //           false, req.query.key]
            //       })
            //       .collection(Test.collection)
            //       .then(() => {
            //         res.end()
            //       }).catch((err) => {
            //         res.end()
            //       })
            //   },
            //   vulnerability: 'NOSQL_MONGODB_INJECTION',
            //   makeRequest: (done, config) => {
            //     axios.get(`http://localhost:${config.port}/?key=value`).catch(done)
            //   }
            // })

            testThatRequestHasVulnerability({
              testDescription: 'should have NOSQL_MONGODB_INJECTION vulnerability in correct file and line',
              fn: async (req, res) => {
                const filter = {
                  name: {
                    child: [req.query.key]
                  }
                }
                require(tmpFilePath)(Test.collection, filter, () => {
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

            testThatRequestHasNoVulnerability(async (req, res) => {
              mquery(Test.collection)
                .find({
                  name: 'test'
                }).then(() => {
                  res.end()
                })
            }, 'NOSQL_MONGODB_INJECTION')
          })
      })
    })
  })
})
