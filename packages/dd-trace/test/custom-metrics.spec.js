'use strict'

/* eslint-disable no-console */

const t = require('tap')
require('./setup/core')

const http = require('http')
const path = require('path')
const os = require('os')
const { exec } = require('child_process')

t.test('Custom Metrics', t => {
  let httpServer
  let httpPort
  let metricsData
  let sockets

  t.beforeEach(async () => {
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
        t.end()
        return
      }
      t.end()
    })
    httpServer.on('connection', socket => sockets.push(socket))
  })

  t.afterEach(() => {
    httpServer.close()
    sockets.forEach(socket => socket.destroy())
  })

  t.test('should send metrics before process exit', (t) => {
    exec(`${process.execPath} ${path.join(__dirname, 'custom-metrics-app.js')}`, {
      env: {
        DD_TRACE_AGENT_URL: `http://127.0.0.1:${httpPort}`
      }
    }, (err, stdout, stderr) => {
      t.error(err)
      if (stdout) console.log(stdout)
      if (stderr) console.error(stderr)

      expect(metricsData.split('#')[0]).to.equal('page.views.data:1|c|')

      t.end()
    })
  })
  t.end()
})
