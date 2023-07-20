import http from 'http'

export function onMessage (handler) {
  const server = http.createServer(async (req, res) => {
    try {
      await handler()
      res.end('integration test response handler success')
    } catch (err) {
      res.status(500).end('integration test response handler failure')
    }
  }).listen(0, () => {
    const port = server.address().port
    process.send({ port })
  })
}