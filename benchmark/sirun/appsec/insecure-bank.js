const http = require('http')
// eslint-disable-next-line import/no-absolute-path
const app = require('/opt/insecure-bank-js/app')

const { port } = require('./common')

app.set('port', port)
const server = http.createServer(app)

server.listen(port, () => { server.close() })
