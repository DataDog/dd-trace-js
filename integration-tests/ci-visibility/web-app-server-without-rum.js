'use strict'

const http = require('http')

const createSimpleServer = () => {
  return http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.writeHead(200)
    res.end(`
      <!DOCTYPE html>
      <html>
      <div class="hella-world">Hella World</div>
      </html>
      `)
  })
}

// When this file gets imported, it will spin up an HTTP server that returns an HTML for cypress/playwright to visit
module.exports = createSimpleServer()
