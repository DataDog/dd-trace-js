import 'dd-trace/init.js'
import http from 'http'
import router from 'router'

const app = router()

app.use((req, res, next) => {
  return next('route')
})

app.get('/foo', (req, res) => {
  res.end()
})

const server = http.createServer((req, res) => {
  return app(req, res, err => {
    res.writeHead(err ? 500 : 404)
    res.end()
  })
})

server.listen(0, () => {
  const port = (/** @type {import('net').AddressInfo} */ (server.address())).port
  process.send({ port })
})
