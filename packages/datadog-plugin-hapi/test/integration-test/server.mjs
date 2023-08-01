import 'dd-trace/init.js'
import Hapi from '@hapi/hapi'
import getPort from 'get-port'
import axios from 'axios'

let server
const port = await getPort()

console.log('PORT is ', port)

const init = async () => {
  server = Hapi.server({ address: '127.0.0.1', port })
  server.route({
    method: 'GET',
    path: '/',
    handler: (request, h) => {
      return h.response('hello, world\n').code(200)
    }
  })
  await server.start()
}

try {
  await init()
  
  await axios.get(`http://localhost:${port}/`)

  await server.stop()
  console.log('Server stopped gracefully.')
} catch (error) {
  console.error('Error occurred:', error)
}
