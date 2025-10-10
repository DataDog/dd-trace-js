import http from 'http'

const server = http.createServer(async (req, res) => {
  try {
    res.end('integration test response handler success')
  } catch (err) {
    res.statusCode = 500
    res.end('integration test response handler failure')
  }
}).listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
