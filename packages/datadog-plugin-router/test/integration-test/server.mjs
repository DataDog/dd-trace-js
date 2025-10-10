import router from 'router'
import http from 'http'

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
  const port = server.address().port
  process.send({ port })
})
