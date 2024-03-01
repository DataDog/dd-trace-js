'use strict'

const agent = require('../plugins/agent')
const getPort = require('get-port')
const axios = require('axios')
const appsec = require('../../src/appsec')
const Config = require('../../src/config')
const path = require('path')
describe('sequelize', () => {
  withVersions('sequelize', 'sequelize', sequelizeVersion => {
    withVersions('mysql2', 'mysql2', (mysqlVersion) => {
      withVersions('sequelize', 'express', (expressVersion) => {
        let sequelize, User, server, port
        // init tracer
        before(async () => {
          await agent.load(['express', 'http'], { client: false }, { flushInterval: 1 })
          appsec.enable(new Config({
            appsec: {
              enabled: true,
              rules: path.join(__dirname, 'express-rules.json'),
              apiSecurity: {
                enabled: true,
                requestSampling: 1
              }
            }
          }))
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
            birthday: new Date(1980, 6, 20),
          })
        })

        // init express
        before(async () => {
          const express = require(`../../../../versions/express@${expressVersion}`).get()
          const app = express()
          app.get('/users', async (req, res) => {
            const users = await User.findAll()
            res.json(users)
          })
          return new Promise(resolve => {
            getPort().then(newPort => {
              port = newPort
              server = app.listen(newPort, () => {
                resolve()
              })
            })
          })
        })

        // stop express
        after(() => {
          return server.close()
        })

        // clean tables
        after(async () => {
          await User.drop()
        })

        // close agent
        after(() => {
          appsec.disable()
          return agent.close()
        })

        it('Should complete the request', (done) => {
          axios.get(`http://localhost:${port}/users`)
            .then(() => done())
            .catch(done)
        })
      })
    })
  })
})
