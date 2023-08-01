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

  await server.start()

  server.route({
    method: 'GET',
    path: '/user/{id}',
    handler: (request, h) => {
      return handler(request, h)
    }
  }) 
}

try {
  await init()
  
  await axios.get(`http://localhost:${port}/user/5`)

  await server.stop()
  console.log('Server stopped gracefully.')
} catch (error) {
  console.error('Error occurred:', error)
}
