'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const os = require('node:os')
const { exec } = require('node:child_process')

const { describe, it, beforeEach, afterEach } = require('mocha')

require('./setup/core')

describe('Custom Metrics', () => {
  let httpServer
  let httpPort
  let metricsData
  let sockets

  beforeEach((done) => {
    sockets = []
    httpServer = http.createServer((req, res) => {
      let httpData = ''
      req.on('data', d => { httpData += d.toString() })
      req.on('end', () => {
        res.statusCode = 200
        res.end()
        if (req.url === '/dogstatsd/v2/proxy') {
          metricsData = httpData
        }
      })
    }).listen(0, () => {
      httpPort = httpServer.address().port
      if (os.platform() === 'win32') {
        done()
        return
      }
      done()
    })
    httpServer.on('connection', socket => sockets.push(socket))
  })

  afterEach(() => {
    httpServer.close()
    sockets.forEach(socket => socket.destroy())
  })

  it('should send metrics before process exit', (done) => {
    exec(`${process.execPath} ${path.join(__dirname, 'custom-metrics-app.js')}`, {
      env: {
        DD_TRACE_AGENT_URL: `http://127.0.0.1:${httpPort}`
      }
    }, (err, stdout, stderr) => {
      if (err) return done(err)
      // eslint-disable-next-line no-console
      if (stdout) console.log(stdout)
      // eslint-disable-next-line no-console
      if (stderr) console.error(stderr)

      assert.strictEqual(metricsData.split('#')[0], 'page.views.data:1|c|')

      done()
    })
  })
})
