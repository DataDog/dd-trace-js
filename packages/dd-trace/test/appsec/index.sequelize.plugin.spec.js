'use strict'

const path = require('path')
const axios = require('axios')
const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const Config = require('../../src/config')

describe('sequelize', () => {
  withVersions('sequelize', 'sequelize', sequelizeVersion => {
    withVersions('mysql2', 'mysql2', () => {
      withVersions('sequelize', 'express', (expressVersion) => {
        let sequelize, User, server, port

        // init tracer
        before(async () => {
          await agent.load(['express', 'http'], { client: false }, { flushInterval: 1 })
          appsec.enable(new Config({
            appsec: {
              enabled: true,
              rules: path.join(__dirname, 'rules-example.json'),
              apiSecurity: {
                enabled: true,
                sampleDelay: 10
              }
            }
          }))
        })

        // close agent
        after(() => {
          appsec.disable()
          return agent.close({ ritmReset: false })
        })

        // init database
        before(async () => {
          const { Sequelize, DataTypes } = require(`../../../../versions/sequelize@${sequelizeVersion}`).get()

          sequelize = new Sequelize('db', 'root', '', {
            host: '127.0.0.1',
            dialect: 'mysql'
          })
          User = sequelize.define('User', {
            username: DataTypes.STRING,
            birthday: DataTypes.DATE
          })

          await sequelize.sync({ force: true })
          await User.create({
            username: 'janedoe',
            birthday: new Date(1980, 6, 20)
          })
        })

        // clean database
        after(async () => {
          await User.drop()
        })

        // init express
        before((done) => {
          const express = require(`../../../../versions/express@${expressVersion}`).get()

          const app = express()
          app.get('/users', async (req, res) => {
            const users = await User.findAll()
            res.json(users)
          })

          server = app.listen(0, () => {
            port = server.address().port
            done()
          })
        })

        // stop express
        after(() => {
          return server.close()
        })

        it('Should complete the request on time', (done) => {
          axios.get(`http://localhost:${port}/users`)
            .then(() => done())
            .catch(done)
        })
      })
    })
  })
})
