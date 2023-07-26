import 'dd-trace/init.js'
import router from 'router'
import http from 'http'

const app = router()

function defaultErrorHandler (req, res) {
  return err => {
    res.writeHead(err ? 500 : 404)
    res.end()
  }
}

function createServer (router, errorHandler = defaultErrorHandler) {
  return http.createServer((req, res) => {
    return router(req, res, errorHandler(req, res))
  })
}

app.use((req, res, next) => {
  return next('route')
})

app.get('/foo', (req, res) => {
  res.end()
})

const server = createServer(app)

server.listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
