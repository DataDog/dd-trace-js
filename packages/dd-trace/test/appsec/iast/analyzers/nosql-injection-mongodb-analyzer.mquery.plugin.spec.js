'use strict'

const { prepareTestServerForIastInExpress } = require('../utils')
const axios = require('axios')
const agent = require('../../../plugins/agent')
const os = require('os')
const path = require('path')
const fs = require('fs')

for (let i = 0; i < 500; i++) {
  describe.only('nosql injection detection with mquery' + i, () => {
    // https://github.com/fiznool/express-mongo-sanitize/issues/200
    withVersions('mquery', 'express', '>4.18.0 <5.0.0', expressVersion => {
      withVersions('mquery', 'mongodb', mongodbVersion => {
        const vulnerableMethodFilename = 'mquery-vulnerable-method.js'
        let client, testCollection, tmpFilePath, dbName

        before(() => {
          return agent.load(['mongodb', 'mquery'], { client: false }, { flushInterval: 1 })
        })

        before(async function () {
          this.timeout(30000)
          const id = require('../../../../src/id')
          dbName = id().toString()
          const mongo = require(`../../../../../../versions/mongodb@${mongodbVersion}`).get()
          console.log('dbName', dbName)
          client = new mongo.MongoClient(`mongodb://localhost:27017/${dbName}`, {
            connectTimeoutMS: 28000,
            useNewUrlParser: true,
            useUnifiedTopology: true
          })
          console.log('connect')
          try {
            await client.connect()
          } catch (e) {
            console.error('errro connecting', e)
            throw e
          }
          console.log('connected')

          testCollection = client.db().collection('Test')

          console.log('insert')
          await testCollection.insertMany([{ id: 1, name: 'value' }, { id: 2, name: 'value2' }])
          console.log('inserted')

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

          await testCollection.deleteMany({})

          await client.close()
        })

        withVersions('mquery', 'mquery', mqueryVersion => {
          const vulnerableMethodFilename = 'mquery-vulnerable-method.js'

          const mqueryPkg = require(`../../../../../../versions/mquery@${mqueryVersion}`)

          let mquery, collection

          before(() => {
            mquery = mqueryPkg.get()
            collection = mquery().collection(testCollection)
          })

          prepareTestServerForIastInExpress('Test with mquery', expressVersion,
            (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
              testThatRequestHasVulnerability({
                testDescription: 'should have NOSQL_MONGODB_INJECTION vulnerability [find exec]',
                occurrences: 1,
                fn: async (req, res) => {
                  try {
                    const result = await collection
                      .find({
                        name: req.query.key
                      })
                      .exec()

                    expect(result).to.not.be.undefined
                    expect(result.length).to.equal(1)
                    expect(result[0].id).to.be.equal(1)
                  } catch (e) {
                    // do nothing
                  }

                  res.end()
                },
                vulnerability: 'NOSQL_MONGODB_INJECTION',
                makeRequest: (done, config) => {
                  axios.get(`http://localhost:${config.port}/?key=value`).catch(done)
                }
              })

              testThatRequestHasVulnerability({
                testDescription: 'should have NOSQL_MONGODB_INJECTION vulnerability [find then]',
                occurrences: 1,
                fn: (req, res) => {
                  try {
                    return collection
                      .find({
                        name: req.query.key
                      })
                      .then((result) => {
                        expect(result).to.not.be.undefined
                        expect(result.length).to.equal(1)
                        expect(result[0].id).to.be.equal(1)

                        res.end()
                      })
                  } catch (e) {
                    // do nothing
                  }
                },
                vulnerability: 'NOSQL_MONGODB_INJECTION',
                makeRequest: (done, config) => {
                  axios.get(`http://localhost:${config.port}/?key=value`).catch(done)
                }
              })

              testThatRequestHasVulnerability({
                testDescription: 'should have NOSQL_MONGODB_INJECTION vulnerability [await find exec]',
                occurrences: 1,
                fn: async (req, res) => {
                  try {
                    await require(tmpFilePath).vulnerableFindExec(collection, { name: req.query.key })
                  } catch (e) {
                    // do nothing
                  }
                  res.end()
                },
                vulnerability: 'NOSQL_MONGODB_INJECTION',
                makeRequest: (done, config) => {
                  axios.get(`http://localhost:${config.port}/?key=value`).catch(done)
                }
              })

              testThatRequestHasVulnerability({
                testDescription: 'should have 2 NOSQL_MONGODB_INJECTION vulnerability [find where exec]',
                fn: async (req, res) => {
                  try {
                    await require(tmpFilePath)
                      .vulnerableFindWhereExec(collection, { name: req.query.key }, { where: req.query.key2 })
                  } catch (e) {
                    // do nothing
                  }
                  res.end()
                },
                vulnerability: 'NOSQL_MONGODB_INJECTION',
                occurrences: 2,
                makeRequest: (done, config) => {
                  axios.get(`http://localhost:${config.port}/?key=value&key2=value2`).catch(done)
                }
              })

              testThatRequestHasVulnerability({
                testDescription: 'should have 2 NOSQL_MONGODB_INJECTION vulnerabilities [await find where exec]',
                occurrences: 2,
                fn: async (req, res) => {
                  try {
                    await require(tmpFilePath)
                      .vulnerableFindWhereExec(collection, { name: req.query.key }, { where: req.query.key2 })
                  } catch (e) {
                    // do nothing
                  }
                  res.end()
                },
                vulnerability: 'NOSQL_MONGODB_INJECTION',
                makeRequest: (done, config) => {
                  axios.get(`http://localhost:${config.port}/?key=value&key2=value2`).catch(done)
                }
              })

              testThatRequestHasVulnerability({
                testDescription: 'should have 1 NOSQL_MONGODB_INJECTION vulnerability [await find where exec]',
                occurrences: 1,
                fn: async (req, res) => {
                  try {
                    await require(tmpFilePath)
                      .vulnerableFindWhereExec(collection, { name: req.query.key }, { where: 'not_tainted' })
                  } catch (e) {
                    // do nothing
                  }
                  res.end()
                },
                vulnerability: 'NOSQL_MONGODB_INJECTION',
                makeRequest: (done, config) => {
                  axios.get(`http://localhost:${config.port}/?key=value&key2=value2`).catch(done)
                }
              })

              testThatRequestHasVulnerability({
                testDescription: 'should have NOSQL_MONGODB_INJECTION vulnerability [find exec]',
                occurrences: 2,
                fn: async (req, res) => {
                  try {
                    const filter = { name: req.query.key }
                    const where = { key2: req.query.key2 }
                    await require(tmpFilePath).vulnerableFindWhere(collection, filter, where)
                  } catch (e) {
                    // do nothing
                  }
                  res.end()
                },
                vulnerability: 'NOSQL_MONGODB_INJECTION',
                makeRequest: (done, config) => {
                  axios.get(`http://localhost:${config.port}/?key=value&key2=value`).catch(done)
                }
              })

              testThatRequestHasVulnerability({
                testDescription: 'should have NOSQL_MONGODB_INJECTION vulnerability in correct file and line [find]',
                fn: async (req, res) => {
                  const filter = {
                    name: req.query.key
                  }
                  try {
                    await require(tmpFilePath).vulnerableFind(collection, filter)
                  } catch (e) {
                    // do nothing
                  }
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

              testThatRequestHasVulnerability({
                testDescription: 'should have NOSQL_MONGODB_INJECTION vulnerability in correct file and line [findOne]',
                fn: async (req, res) => {
                  const filter = {
                    name: req.query.key
                  }
                  try {
                    await require(tmpFilePath).vulnerableFindOne(collection, filter)
                  } catch (e) {
                    // do nothing
                  }
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
                    line: 10
                  }
                }
              })

              // this is a known issue. In this case promise is not resolved and exec method is not called but
              // we are reporting the vulnerability
              testThatRequestHasVulnerability({
                testDescription: 'should have no NOSQL_MONGODB_INJECTION vulnerability [find without call exec or await]',
                fn: (req, res) => {
                  try {
                    require(tmpFilePath)
                      .vulnerableFind(collection, { name: req.query.key })
                  } catch (e) {
                    // do nothing
                  }
                  res.end()
                },
                vulnerability: 'NOSQL_MONGODB_INJECTION',
                makeRequest: (done, config) => {
                  axios.get(`http://localhost:${config.port}/?key=value&key2=value2`).catch(done)
                }
              })

              testThatRequestHasNoVulnerability(async (req, res) => {
                try {
                  await collection
                    .find({
                      name: 'test'
                    })
                } catch (e) {
                  // do nothing
                }
                res.end()
              }, 'NOSQL_MONGODB_INJECTION')

              testThatRequestHasNoVulnerability(async (req, res) => {
                try {
                  await collection
                    .find()
                } catch (e) {
                  // do nothing
                }
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
                  const filter = {
                    name: req.query.key
                  }
                  try {
                    await require(tmpFilePath).vulnerableFindOne(collection, filter)
                  } catch (e) {
                    // do nothing
                  }
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
  })
}
