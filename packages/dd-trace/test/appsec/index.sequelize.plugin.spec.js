'use strict'

const path = require('path')

const axios = require('axios')

const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const { getConfigFresh } = require('../helpers/config')
const { withVersions } = require('../setup/mocha')

describe('sequelize', () => {
  withVersions('sequelize', 'sequelize', sequelizeVersion => {
    let sequelize, User

    // init database
    before(async () => {
      const { Sequelize, DataTypes } = require(`../../../../versions/sequelize@${sequelizeVersion}`).get()

      sequelize = new Sequelize('db', 'root', '', {
        host: '127.0.0.1',
        dialect: 'mysql',
      })
      User = sequelize.define('User', {
        username: DataTypes.STRING,
        birthday: DataTypes.DATE,
      })

      await sequelize.sync({ force: true })
      await User.create({
        username: 'janedoe',
        birthday: new Date(1980, 6, 20),
      })
    })

    // clean database
    after(async () => {
      await User.drop()
    })

    withVersions('mysql2', 'mysql2', () => {
      withVersions('sequelize', ['express', 'mysql2'], (expressVersion) => {
        let server, port

        // init tracer
        before(async () => {
          await agent.load(['express', 'http'], { client: false }, { flushInterval: 1 })
          appsec.enable(getConfigFresh({
            appsec: {
              enabled: true,
              rules: path.join(__dirname, 'rules-example.json'),
              apiSecurity: {
                enabled: true,
                sampleDelay: 10,
              },
            },
          }))
        })

        // close agent
        after(() => {
          appsec.disable()
          return agent.close({ ritmReset: false })
        })

        // init express
        before((done) => {
          const express = require(`../../../../versions/express@${expressVersion}`).get()
          console.log('Express version', expressVersion, require(`../../../../versions/express@${expressVersion}`).version())

          const app = express()
          app.get('/users', async (req, res) => {
            console.log('Users controller - begin')
            const users = await User.findAll()
            console.log('Users controller - after findAll')
            res.json(users)
            console.log('Users controller - after res.json')
          })

          server = app.listen(0, () => {
            console.log('App listening')
            port = (/** @type {import('net').AddressInfo} */ (server.address())).port
            done()
          })
        })

        // stop express
        after(() => {
          return server.close()
        })

        it('Should complete the request on time', (done) => {
          axios.get(`http://localhost:${port}/users`)
            .then(() => {console.log('Response received'); done()})
            .catch(done)
          console.log('Request done')
        })
      })
    })
  })
})
