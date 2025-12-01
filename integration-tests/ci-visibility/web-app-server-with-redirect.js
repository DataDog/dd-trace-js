'use strict'

// File to spin an HTTP server that returns an HTML for playwright to visit
const http = require('http')

function createWebAppServerWithRedirect () {
  return http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.writeHead(200)
    res.end(`
      <!DOCTYPE html>
      <meta http-equiv="refresh" content="0; url=https://playwright.dev/" />
    `)
  })
}

// For backward compatibility, export a default instance
module.exports = createWebAppServerWithRedirect()
// Also export the factory function for creating fresh instances
module.exports.createWebAppServerWithRedirect = createWebAppServerWithRedirect
