'use strict'

const sinon = require('sinon')
const chai = require('chai')
const sinonChai = require('sinon-chai')
const proxyquire = require('proxyquire')
const nock = require('nock')
const retry = require('retry')
const pg = require('pg')
const mysql = require('mysql')
const redis = require('redis')
const platform = require('../src/platform')
const node = require('../src/platform/node')

const retryOptions = {
  retries: 10,
  factor: 1,
  minTimeout: 3000,
  maxTimeout: 3000,
  randomize: false
}

chai.use(sinonChai)

global.sinon = sinon
global.expect = chai.expect
global.proxyquire = proxyquire
global.nock = nock

platform.use(node)

waitForServices()
  .then(run)
  .catch(err => {
    setImmediate(() => { throw err })
  })

function waitForServices () {
  return Promise.all([
    waitForPostgres(),
    waitForMysql(),
    waitForRedis()
  ])
}

function waitForPostgres () {
  return new Promise((resolve, reject) => {
    const operation = retry.operation(retryOptions)

    operation.attempt(currentAttempt => {
      const client = new pg.Client({
        user: 'postgres',
        password: 'postgres',
        database: 'postgres',
        application_name: 'test'
      })

      client.connect((err) => {
        if (operation.retry(err)) return
        if (err) return reject(err)

        client.query('SELECT version()', (err, result) => {
          if (operation.retry(err)) return
          if (err) return reject(err)

          client.end((err) => {
            if (operation.retry(err)) return
            if (err) return reject(err)

            resolve()
          })
        })
      })
    })
  })
}

function waitForMysql () {
  return new Promise((resolve, reject) => {
    const operation = retry.operation(retryOptions)

    operation.attempt(currentAttempt => {
      const connection = mysql.createConnection({
        host: 'localhost',
        user: 'user',
        password: 'userpass',
        database: 'db'
      })

      connection.connect(err => {
        if (operation.retry(err)) return
        if (err) reject(err)

        connection.end(() => resolve())
      })
    })
  })
}

function waitForRedis () {
  return new Promise((resolve, reject) => {
    const client = redis.createClient({
      retry_strategy: function (options) {
        if (options.attempt > retryOptions.retries) {
          return reject(options.error)
        }

        return retryOptions.maxTimeout
      }
    })

    client.on('connect', () => {
      client.quit()
      resolve()
    })
  })
}
