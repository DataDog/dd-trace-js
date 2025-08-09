'use strict'

const { prepareTestServerForIast } = require('../../utils')

const connectionData = {
  host: '127.0.0.1',
  user: 'postgres',
  password: 'postgres',
  database: 'postgres',
  application_name: 'test'
}

describe('db sources with pg', () => {
  let pg
  withVersions('pg', 'pg', '>=8.0.3', version => {
    let client
    beforeEach(async () => {
      pg = require(`../../../../../../../versions/pg@${version}`).get()
      client = new pg.Client(connectionData)
      await client.connect()

      await client.query(`CREATE TABLE IF NOT EXISTS examples (
                                      id INT,
                                      name VARCHAR(50),
                                      query VARCHAR(100),
                                      command VARCHAR(50))`)

      await client.query(`INSERT INTO examples (id, name, query, command)
                                     VALUES (1, 'Item1', 'SELECT 1', 'ls'),
                                            (2, 'Item2', 'SELECT 1', 'ls'),
                                            (3, 'Item3', 'SELECT 1', 'ls')`)
    })

    afterEach(async () => {
      await client.query('DROP TABLE examples')
      client.end()
    })

    prepareTestServerForIast('sequelize', (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
      describe('using pg.Client', () => {
        testThatRequestHasVulnerability(async (req, res) => {
          const result = await client.query('SELECT * FROM examples')

          const firstItem = result.rows[0]

          await client.query(firstItem.query)

          res.end()
        }, 'SQL_INJECTION', { occurrences: 1 }, null, null,
        'Should have SQL_INJECTION using the first row of the result')

        testThatRequestHasNoVulnerability(async (req, res) => {
          const result = await client.query('SELECT * FROM examples')

          const secondItem = result.rows[1]

          await client.query(secondItem.query)

          res.end()
        }, 'SQL_INJECTION', null, 'Should not taint the second row of a query with default configuration')

        testThatRequestHasNoVulnerability(async (req, res) => {
          const result = await client.query('SELECT * from examples')
          const firstItem = result.rows[0]

          const childProcess = require('child_process')
          childProcess.execSync(firstItem.command)

          res.end('OK')
        }, 'COMMAND_INJECTION', null, 'Should not detect COMMAND_INJECTION with database source')
      })

      describe('using pg.Pool', () => {
        let pool

        beforeEach(() => {
          pool = new pg.Pool(connectionData)
        })

        testThatRequestHasVulnerability(async (req, res) => {
          const result = await pool.query('SELECT * FROM examples')

          const firstItem = result.rows[0]

          await client.query(firstItem.query)

          res.end()
        }, 'SQL_INJECTION', { occurrences: 1 }, null, null,
        'Should have SQL_INJECTION using the first row of the result')

        testThatRequestHasNoVulnerability(async (req, res) => {
          const result = await pool.query('SELECT * FROM examples')

          const secondItem = result.rows[1]

          await client.query(secondItem.query)

          res.end()
        }, 'SQL_INJECTION', null, 'Should not taint the second row of a query with default configuration')

        testThatRequestHasNoVulnerability(async (req, res) => {
          const result = await pool.query('SELECT * from examples')
          const firstItem = result.rows[0]

          const childProcess = require('child_process')
          childProcess.execSync(firstItem.command)

          res.end('OK')
        }, 'COMMAND_INJECTION', null, 'Should not detect COMMAND_INJECTION with database source')
      })
    }, undefined, ['pg'])
  })
})
