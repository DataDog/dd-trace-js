'use strict'

/* eslint-disable no-console */

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('tap').mocha

const http = require('node:http')
const path = require('node:path')
const os = require('node:os')
const { exec } = require('node:child_process')

require('./setup/tap')

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
      if (stdout) console.log(stdout)
      if (stderr) console.error(stderr)

      expect(metricsData.split('#')[0]).to.equal('page.views.data:1|c|')

      done()
    })
  })
})
