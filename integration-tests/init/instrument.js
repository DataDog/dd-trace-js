const http = require('http')
const dc = require('dc-polyfill')

let gotEvent = false
dc.subscribe('apm:http:client:request:start', (event) => {
  gotEvent = true
})

const server = http.createServer((req, res) => {
  res.end('Hello World')
}).listen(0, () => {
  http.get(`http://localhost:${server.address().port}`, (res) => {
    res.on('data', () => {})
    res.on('end', () => {
      server.close()
      // eslint-disable-next-line no-console
      console.log(gotEvent)
      process.exit()
    })
  })
})
