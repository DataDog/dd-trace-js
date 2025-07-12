'use strict'

// File to spin an HTTP server that returns an HTML for playwright to visit
const http = require('http')
const coverage = require('../ci-visibility/fixtures/coverage.json')

module.exports = http.createServer((req, res) => {
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
