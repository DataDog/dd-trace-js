'use strict'

// File to spin an HTTP server that returns an HTML for playwright to visit
const http = require('http')
const coverage = require('../ci-visibility/fixtures/istanbul-map-fixture.json')

function createWebAppServer () {
  const server = http.createServer((req, res) => {
    // Close after each response so browser drivers don't reuse a socket the
    // server has already FIN'd between requests (keep-alive race → `socket hang up`).
    res.setHeader('Content-Type', 'text/html')
    res.setHeader('Connection', 'close')
    res.writeHead(200)
    res.end(`
      <!DOCTYPE html>
      <html>
        <title>Hello World</title>
        <script>
          window.DD_RUM = {
            getInternalContext: () => {
              return true
            },
            stopSession: () => {
              return true
            }
          }
        </script>
        <body>
          <div class="hello-world">Hello World</div>
        </body>
        <script>
          window.__coverage__ = ${JSON.stringify(coverage)}
        </script>
      </html>
    `)
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

module.exports = createWebAppServer()
module.exports.createWebAppServer = createWebAppServer
