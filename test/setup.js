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
const mongo = require('mongodb-core')
const elasticsearch = require('elasticsearch')
const amqplib = require('amqplib/callback_api')
const platform = require('../src/platform')
const node = require('../src/platform/node')

const retryOptions = {
  retries: 60,
  factor: 1,
  minTimeout: 5000,
  maxTimeout: 5000,
  randomize: false
}

chai.use(sinonChai)

global.sinon = sinon
global.expect = chai.expect
global.proxyquire = proxyquire
global.nock = nock
global.wrapIt = wrapIt

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
    waitForRedis(),
    waitForMongo(),
    waitForElasticsearch(),
    waitForRabbitMQ()
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

function waitForMongo () {
  return new Promise((resolve, reject) => {
    const operation = retry.operation(retryOptions)

    operation.attempt(currentAttempt => {
      const server = new mongo.Server({
        host: 'localhost',
        port: 27017,
        reconnect: false
      })

      server.on('connect', server => {
        server.destroy()
        resolve()
      })

      server.on('error', err => {
        if (!operation.retry(err)) {
          reject(err)
        }
      })

      server.connect()
    })
  })
}

function waitForElasticsearch () {
  return new Promise((resolve, reject) => {
    const operation = retry.operation(retryOptions)

    operation.attempt(currentAttempt => {
      const client = new elasticsearch.Client({
        host: 'localhost:9200'
      })

      client.ping((err) => {
        if (operation.retry(err)) return
        if (err) reject(err)

        resolve()
      })
    })
  })
}

function waitForRabbitMQ () {
  return new Promise((resolve, reject) => {
    const operation = retry.operation(retryOptions)

    operation.attempt(currentAttempt => {
      amqplib
        .connect((err, conn) => {
          if (operation.retry(err)) return
          if (err) reject(err)

          conn.close(() => resolve())
        })
    })
  })
}

function wrapIt () {
  const it = global.it

  global.it = function (title, fn) {
    if (fn.length > 0) {
      return it.call(this, title, function (done) {
        const context = platform.context()

        arguments[0] = context.bind(done)

        return fn.apply(this, arguments)
      })
    } else {
      return it.call(this, title, function () {
        const context = platform.context()
        const defer = {}

        defer.promise = new Promise((resolve, reject) => {
          defer.resolve = context.bind(resolve)
          defer.reject = context.bind(reject)
        })

        const result = fn.apply(this, arguments)

        if (result && result.then) {
          return result
            .then(function () {
              defer.resolve.apply(defer, arguments)
              return defer.promise
            })
            .catch(function () {
              defer.reject.apply(defer, arguments)
              return defer.promise
            })
        }

        return result
      })
    }
  }
}
