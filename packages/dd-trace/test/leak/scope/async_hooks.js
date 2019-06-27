'use strict'

const tracer = require('../../..')

const ASYNC_HOOKS = require('../../../../../ext/scopes').ASYNC_HOOKS

tracer.init({
  scope: ASYNC_HOOKS
})

const ah = require('async_hooks')
const test = require('tape')
const http = require('http')
const getPort = require('get-port')
const profile = require('../../profile')

const host = '127.0.0.1'
const listen = (port, hostname, listeningListener) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200)
    res.end()
  })

  return server.listen(port, hostname, listeningListener)
}

test('Scope should handle HTTP resource leaks in Node', t => {
  getPort().then(port => {
    const agent = new http.Agent({ keepAlive: true })
    const listener = listen(port, host, () => {
      profile(t, operation)
        .then(() => {
          listener.close()
        })

      function operation (done) {
        const request = http.request({ host, port, agent }, res => {
          res.resume()
          done()
        })

        request.end()
      }
    })
  })
})

test('Scope should not lose active span when handling leaks in Node', t => {
  t.plan(1)

  const asyncIds = new Set()
  const leakIds = new Set()

  let failed = 0

  const hook = ah.createHook({
    init (asyncId, type) {
      asyncIds.add(asyncId)

      if (type === 'TCPWRAP' || type === 'HTTPPARSER') {
        leakIds.add(asyncId)
      }
    },
    after (asyncId) {
      if (leakIds.has(asyncId) && !asyncIds.has(asyncId)) {
        failed++
      }
    },
    destroy (asyncId) {
      asyncIds.delete(asyncId)
    }
  })

  hook.enable()

  getPort().then(port => {
    const agent = new http.Agent({
      keepAlive: true,
      maxSockets: 5,
      maxFreeSockets: 5
    })

    const listener = listen(port, host, () => {
      const promises = []

      for (let i = 0; i < 100; i++) {
        const promise = new Promise((resolve, reject) => {
          http.get({ host, port, agent }, res => {
            res.resume()
            resolve()
          })
        })

        promises.push(promise)
      }

      Promise.all(promises)
        .then(() => {
          if (failed) {
            t.fail(`the active span was lost by ${failed} scopes`)
          } else {
            t.ok('no scope lost the active span')
          }

          listener.close()
        })
    })
  })
})
