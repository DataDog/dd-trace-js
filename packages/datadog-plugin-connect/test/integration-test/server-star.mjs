import 'dd-trace/init.js'
import * as modconnect from 'connect'
const connect = modconnect.default

const app = connect()

app.use((req, res) => {
  res.end('hello, world\n')
})

const server = app.listen(0, () => {
  const port = server.address().port
  process.send({ port })
})

