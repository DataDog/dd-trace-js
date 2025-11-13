'use strict'

// File to spin an HTTP server that returns an HTML for playwright to visit
const http = require('http')
const coverage = require('../ci-visibility/fixtures/coverage.json')

function createWebAppServer () {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html')
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

  // Increase connection backlog to handle multiple concurrent connections
  server.maxConnections = 100

  // Set keep-alive timeout (default is 5000ms, increase for stability)
  server.keepAliveTimeout = 10000

  // Set headers timeout (should be higher than keepAliveTimeout)
  server.headersTimeout = 12000

  // Handle server errors gracefully
  server.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('Web app server error:', err)
  })

  // Handle client errors gracefully
  server.on('clientError', (err, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    }
  })

  return server
}

// For backward compatibility, export a default instance
module.exports = createWebAppServer()
// Also export the factory function for creating fresh instances
module.exports.createWebAppServer = createWebAppServer
