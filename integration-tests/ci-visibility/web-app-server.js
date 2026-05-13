'use strict'

// File to spin an HTTP server that returns an HTML for browser tests to visit
const http = require('node:http')

const coverage = require('../ci-visibility/fixtures/istanbul-map-fixture.json')

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_BODY = '<div class="hello-world">Hello World</div>'

/**
 * @typedef {object} WebAppServerOptions
 * @property {string} [body] - HTML body fragment rendered by the test app.
 * @property {boolean} [includeCoverage=true] - Whether to expose the Istanbul fixture on window.__coverage__.
 * @property {boolean} [includeRum=true] - Whether to expose the fake DD_RUM helper.
 * @property {string} [title] - HTML title rendered by the test app.
 */

/**
 * @typedef {object} StartedWebAppServer
 * @property {string} baseUrl - Base URL for browser tests.
 * @property {number} port - Port used by the server.
 * @property {import('node:http').Server} server - Running HTTP server.
 */

/**
 * Builds the static HTML returned by the browser test web app.
 *
 * @param {WebAppServerOptions} [options]
 * @returns {string}
 */
function getWebAppHtml (options = {}) {
  const {
    body = DEFAULT_BODY,
    includeCoverage = true,
    includeRum = true,
    title = 'Hello World',
  } = options

  const rumScript = includeRum
    ? `
        <script>
          window.DD_RUM = {
            getInternalContext: () => {
              return true
            },
            stopSession: () => {
              return true
            }
          }
        </script>`
    : ''

  const coverageScript = includeCoverage
    ? `
        <script>
          window.__coverage__ = ${JSON.stringify(coverage)}
        </script>`
    : ''

  return `
      <!DOCTYPE html>
      <html>
        <title>${title}</title>
        ${rumScript}
        <body>
          ${body}
        </body>
        ${coverageScript}
      </html>
    `
}

/**
 * Creates a stateless HTTP server for browser integration tests.
 *
 * @param {WebAppServerOptions} [options]
 * @returns {import('node:http').Server}
 */
function createWebAppServer (options) {
  const html = getWebAppHtml(options)
  const server = http.createServer((req, res) => {
    // Close after each response so browser drivers don't reuse a socket the
    // server has already FIN'd between requests (keep-alive race → `socket hang up`).
    res.setHeader('Content-Type', 'text/html')
    res.setHeader('Connection', 'close')
    res.writeHead(200)
    res.end(html)
  })

  server.on('error', (error) => {
    // eslint-disable-next-line no-console
    console.error('Web app server error:', error)
  })

  server.on('clientError', (error, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    }
  })

  return server
}

/**
 * Starts a web app server on a loopback-only ephemeral port.
 *
 * @param {WebAppServerOptions & { host?: string }} [options]
 * @returns {Promise<StartedWebAppServer>}
 */
function startWebAppServer (options = {}) {
  const { host = DEFAULT_HOST, ...serverOptions } = options
  const server = createWebAppServer(serverOptions)

  return new Promise((resolve, reject) => {
    server.once('error', onError)
    server.listen(0, host, () => {
      server.removeListener('error', onError)

      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Web app server did not bind to a TCP port'))
        return
      }

      resolve({
        baseUrl: `http://${host}:${address.port}`,
        port: address.port,
        server,
      })
    })

    function onError (error) {
      server.removeListener('error', onError)
      reject(error)
    }
  })
}

/**
 * Stops a web app server if it is running.
 *
 * @param {StartedWebAppServer|import('node:http').Server|undefined} webAppServer
 * @returns {Promise<void>}
 */
function stopWebAppServer (webAppServer) {
  const server = webAppServer?.server || webAppServer

  if (!server?.listening) {
    return Promise.resolve()
  }

  return new Promise(resolve => server.close(() => resolve()))
}

module.exports = createWebAppServer()
module.exports.createWebAppServer = createWebAppServer
module.exports.startWebAppServer = startWebAppServer
module.exports.stopWebAppServer = stopWebAppServer
