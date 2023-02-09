// File to spin an HTTP server that returns an HTML for playwright to visit
const http = require('http')

module.exports = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.writeHead(200)
  res.end(`
    <!DOCTYPE html>
    <html>
      <body>
        <div class="hello-world">Hello World</div>
      </body>
    </html>
  `)
})
