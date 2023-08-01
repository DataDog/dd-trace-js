import 'dd-trace/init.js'
import Hapi from '@hapi/hapi'
import getPort from 'get-port'
import axios from 'axios'

let server
const port = await getPort()

console.log('PORT is ', port)

const handler = (request, h, body) => h.response ? h.response(body) : h(body)

const init = async () => {
  server = Hapi.server({
    address: '127.0.0.1',
    port
  })
  server.route({
    method: 'GET',
    path: '/',
    handler: (request, h) => {
      return handler(request, h)
    }
  })
  await server.start()
}

try {
  await init()
  
  await axios.get(`http://localhost:${port}/`).catch(() => {})

  await server.stop()
  console.log('Server stopped gracefully.')
} catch (error) {
  console.error('Error occurred:', error)
}
