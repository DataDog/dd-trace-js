'use strict'

const sinon = require('sinon')
const chai = require('chai')
const sinonChai = require('sinon-chai')
const proxyquire = require('proxyquire')
const nock = require('nock')
const semver = require('semver')
const retry = require('retry')
const pg = require('pg')
const mysql = require('mysql')
const redis = require('redis')
const mongo = require('mongodb-core')
const elasticsearch = require('elasticsearch')
const amqplib = require('amqplib/callback_api')
const platform = require('../src/platform')
const node = require('../src/platform/node')
const ScopeManager = require('../src/scope/scope_manager')

const scopeManager = new ScopeManager()

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
global.withVersions = withVersions

platform.use(node)

after(() => {
  scopeManager._disable()
})

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
        user: 'root',
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

function withoutScope (fn) {
  return function () {
    let active

    while ((active = scopeManager.active())) {
      active.close()
    }

    return fn.apply(this, arguments)
  }
}

function wrapIt () {
  const it = global.it

  global.it = function (title, fn) {
    if (!fn) {
      return it.apply(this, arguments)
    }

    if (fn.length > 0) {
      return it.call(this, title, function (done) {
        arguments[0] = withoutScope(done)

        return fn.apply(this, arguments)
      })
    } else {
      return it.call(this, title, function () {
        const result = fn.apply(this, arguments)

        if (result && result.then) {
          return result
            .then(withoutScope(res => res))
            .catch(withoutScope(err => Promise.reject(err)))
        }

        return result
      })
    }
  }
}

function withVersions (plugin, moduleName, range, cb) {
  const instrumentations = [].concat(plugin)
  const testVersions = new Map()

  if (!cb) {
    cb = range
    range = null
  }

  instrumentations
    .filter(instrumentation => instrumentation.name === moduleName)
    .forEach(instrumentation => {
      instrumentation.versions
        .filter(version => !range || semver.satisfies(version, range))
        .forEach(version => {
          const min = semver.coerce(version).version
          const max = require(`./plugins/versions/${moduleName}@${version}`).version()

          testVersions.set(min, { range: version, test: min })
          testVersions.set(max, { range: version, test: version })
        })
    })

  Array.from(testVersions)
    .sort(v => v[0].localeCompare(v[0]))
    .map(v => Object.assign({}, v[1], { version: v[0] }))
    .forEach(v => {
      describe(`with ${moduleName} ${v.range} (${v.version})`, () => cb(v.test))
    })
}
