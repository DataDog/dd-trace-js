const http = require('http')
const app = require('/opt/insecure-bank-js/app')

const { port } = require('./common')

app.set('port', port)
const server = http.createServer(app)

server.listen(port, () => { server.close() })
