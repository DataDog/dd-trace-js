'use strict'

// One side of the parity comparison: initialise the tracer per the environment the
// harness set, drive every route of the shared app once, flush, exit.

const http = require('node:http')

const tracer = require('../../../').init()

const { ROUTES, startApp } = require('./app')

async function main () {
  // A fixed port, so `http.url`, `tcp.connect`'s resource and every port metric are
  // identical across the two runs instead of carrying an ephemeral port each.
  const app = await startApp({ tracer, port: Number(process.env.PARITY_APP_PORT) })
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })

  for (const route of ROUTES) {
    await request(`http://127.0.0.1:${app.port}${route}`, agent)
  }

  agent.destroy()
  await app.close()

  // Give both implementations a window to flush: the baseline's exporter interval
  // and the native path's ~1-second timer. Then let the process end on its own —
  // `process.exit()` would skip the `beforeExit` flush both paths register, and the
  // native path's HTTP PUT runs on a worker thread that needs the loop alive.
  await new Promise(resolve => setTimeout(resolve, 2500))
}

/**
 * @param {string} url
 * @param {http.Agent} agent
 * @returns {Promise<void>}
 */
function request (url, agent) {
  return new Promise((resolve, reject) => {
    http.get(url, { agent }, response => {
      response.resume()
      response.once('end', resolve)
    }).once('error', reject)
  })
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
