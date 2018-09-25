'use strict'

const sinon = require('sinon')
const chai = require('chai')
const sinonChai = require('sinon-chai')
const proxyquire = require('proxyquire')
const nock = require('nock')
const semver = require('semver')
const retry = require('retry')
const RetryOperation = require('retry/lib/retry_operation')
const pg = require('pg')
const mysql = require('mysql')
const redis = require('redis')
const mongo = require('mongodb-core')
const axios = require('axios')
const amqplib = require('amqplib/callback_api')
const amqp = require('amqp10')
const Memcached = require('memcached')
const platform = require('../src/platform')
const node = require('../src/platform/node')
const ScopeManager = require('../src/scope/scope_manager')
const agent = require('./plugins/agent')
const externals = require('./plugins/externals.json')

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

afterEach(() => {
  agent.reset()
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
    waitForRabbitMQ(),
    waitForQpid(),
    waitForMemcached()
  ])
}

function waitForPostgres () {
  return new Promise((resolve, reject) => {
    const operation = createOperation('postgres')

    operation.attempt(currentAttempt => {
      const client = new pg.Client({
        user: 'postgres',
        password: 'postgres',
        database: 'postgres',
        application_name: 'test'
      })

      client.connect((err) => {
        if (retryOperation(operation, err)) return
        if (err) return reject(err)

        client.query('SELECT version()', (err, result) => {
          if (retryOperation(operation, err)) return
          if (err) return reject(err)

          client.end((err) => {
            if (retryOperation(operation, err)) return
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
    const operation = createOperation('mysql')

    operation.attempt(currentAttempt => {
      const connection = mysql.createConnection({
        host: 'localhost',
        user: 'root',
        database: 'db'
      })

      connection.connect(err => {
        if (retryOperation(operation, err)) return
        if (err) return reject(err)

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
        } else {
          logAttempt('redis', 'failed to connect')
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
    const operation = createOperation('mongo')

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
        if (!retryOperation(operation, err)) {
          reject(err)
        }
      })

      server.connect()
    })
  })
}

function waitForElasticsearch () {
  return new Promise((resolve, reject) => {
    const operation = createOperation('elasticsearch')

    operation.attempt(currentAttempt => {
      // Not using ES client because it's buggy for initial connection.
      axios.get('http://localhost:9200/_cluster/health?wait_for_status=green&local=true&timeout=100ms')
        .then(() => resolve())
        .catch(err => {
          if (retryOperation(operation, err)) return
          reject(err)
        })
    })
  })
}

function waitForRabbitMQ () {
  return new Promise((resolve, reject) => {
    const operation = createOperation('rabbitmq')

    operation.attempt(currentAttempt => {
      amqplib
        .connect((err, conn) => {
          if (retryOperation(operation, err)) return
          if (err) return reject(err)

          conn.close(() => resolve())
        })
    })
  })
}

function waitForQpid () {
  return new Promise((resolve, reject) => {
    const operation = retry.operation(retryOptions)

    operation.attempt(currentAttempt => {
      const client = new amqp.Client(amqp.Policy.merge({
        reconnect: null
      }))

      client.connect('amqp://admin:admin@localhost:5673')
        .then(() => client.disconnect())
        .then(() => resolve())
        .catch(err => {
          if (operation.retry(err)) return
          reject(err)
        })
    })
  })
}

function waitForMemcached () {
  return new Promise((resolve, reject) => {
    const operation = createOperation('memcached')

    operation.attempt(currentAttempt => {
      const memcached = new Memcached('localhost:11211', { retries: 0 })

      memcached.version((err, version) => {
        if (retryOperation(operation, err)) return
        if (err) return reject(err)

        memcached.end()
        resolve()
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
        arguments[0] = withoutScope(agent.wrap(done))

        return fn.apply(this, arguments)
      })
    } else {
      return it.call(this, title, function () {
        const result = fn.apply(this, arguments)

        if (result && result.then) {
          return result
            .then(withoutScope(res => res))
            .catch(withoutScope(err => Promise.reject(err)))
            .then(() => agent.promise())
        }

        return agent.promise()
          .then(() => result)
      })
    }
  }
}

function withVersions (plugin, moduleName, range, cb) {
  const instrumentations = [].concat(plugin, externals)
  const testVersions = new Map()

  if (!cb) {
    cb = range
    range = null
  }

  instrumentations
    .filter(instrumentation => instrumentation.name === moduleName)
    .forEach(instrumentation => {
      instrumentation.versions
        .forEach(version => {
          try {
            const min = semver.coerce(version).version
            require(`./plugins/versions/${moduleName}@${min}`).get()
            testVersions.set(min, { range: version, test: min })
          } catch (e) {
            // skip unsupported version
          }

          agent.wipe()

          try {
            const max = require(`./plugins/versions/${moduleName}@${version}`).version()
            require(`./plugins/versions/${moduleName}@${version}`).get()
            testVersions.set(max, { range: version, test: version })
          } catch (e) {
            // skip unsupported version
          }

          agent.wipe()
        })
    })

  Array.from(testVersions)
    .filter(v => !range || semver.satisfies(v[0], range))
    .sort(v => v[0].localeCompare(v[0]))
    .map(v => Object.assign({}, v[1], { version: v[0] }))
    .forEach(v => {
      describe(`with ${moduleName} ${v.range} (${v.version})`, () => cb(v.test))
    })

  agent.wipe()
}

function createOperation (service) {
  const timeouts = retry.timeouts(retryOptions)
  return new RetryOperation(timeouts, Object.assign({ service }, retryOptions))
}

function retryOperation (operation, err) {
  const shouldRetry = operation.retry(err)
  if (shouldRetry) {
    logAttempt(operation._options.service, err.message)
  }
  return shouldRetry
}

function logAttempt (service, message) {
  // eslint-disable-next-line no-console
  console.error(`[Retrying connection to ${service}] ${message}`)
}
