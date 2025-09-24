'use strict'

const { prepareTestServerForIast } = require('../../utils')
const { withVersions } = require('../../../../setup/mocha')

describe('db sources with sequelize', () => {
  withVersions('sequelize', 'sequelize', sequelizeVersion => {
    prepareTestServerForIast('sequelize', (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
      let Sequelize, sequelize

      beforeEach(async () => {
        Sequelize = require(`../../../../../../../versions/sequelize@${sequelizeVersion}`).get()
        sequelize = new Sequelize('database', 'username', 'password', {
          dialect: 'sqlite',
          logging: false
        })
        await sequelize.query(`CREATE TABLE examples (
                                id INT,
                                name VARCHAR(50),
                                query VARCHAR(100),
                                command VARCHAR(50),
                                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                                updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP )`)

        await sequelize.query(`INSERT INTO examples (id, name, query, command)
                               VALUES (1, 'Item1', 'SELECT 1', 'ls'),
                                      (2, 'Item2', 'SELECT 1', 'ls'),
                                      (3, 'Item3', 'SELECT 1', 'ls')`)
      })

      afterEach(() => {
        return sequelize.close()
      })

      describe('using query method', () => {
        testThatRequestHasVulnerability(async (req, res) => {
          const result = await sequelize.query('SELECT * from examples')

          await sequelize.query(result[0][0].query)

          res.end('OK')
        }, 'SQL_INJECTION', { occurrences: 1 }, null, null,
        'Should have SQL_INJECTION using the first row of the result', false)

        testThatRequestHasNoVulnerability(async (req, res) => {
          const result = await sequelize.query('SELECT * from examples')

          await sequelize.query(result[0][1].query)

          res.end('OK')
        }, 'SQL_INJECTION', null, 'Should not taint the second row of a query with default configuration')

        testThatRequestHasNoVulnerability(async (req, res) => {
          const result = await sequelize.query('SELECT * from examples')

          const childProcess = require('child_process')
          childProcess.execSync(result[0][0].command)

          res.end('OK')
        }, 'COMMAND_INJECTION', null, 'Should not detect COMMAND_INJECTION with database source')
      })

      describe('using Model', () => {
        // let Model
        let Example

        beforeEach(() => {
          Example = sequelize.define('example', {
            id: {
              type: Sequelize.DataTypes.INTEGER,
              primaryKey: true
            },
            name: Sequelize.DataTypes.STRING,
            query: Sequelize.DataTypes.STRING,
            command: Sequelize.DataTypes.STRING
          })
        })

        testThatRequestHasVulnerability(async (req, res) => {
          const examples = await Example.findAll()

          await sequelize.query(examples[0].query)

          res.end('OK')
        }, 'SQL_INJECTION', { occurrences: 1 }, null, null,
        'Should have SQL_INJECTION using the first row of the result', false)

        testThatRequestHasNoVulnerability(async (req, res) => {
          const examples = await Example.findAll()

          await sequelize.query(examples[1].query)

          res.end('OK')
        }, 'SQL_INJECTION', null, 'Should not taint the second row of a query with default configuration')

        testThatRequestHasNoVulnerability(async (req, res) => {
          const examples = await Example.findAll()

          const childProcess = require('child_process')
          childProcess.execSync(examples[0].command)

          res.end('OK')
        }, 'COMMAND_INJECTION', null, 'Should not detect COMMAND_INJECTION with database source')
      })
    })
  })
})
