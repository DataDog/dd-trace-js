const http = require('http')
const app = require('/opt/insecure-bank-js/app') // eslint-disable-line import/no-absolute-path

const { port } = require('./common')

app.set('port', port)
const server = http.createServer(app)

server.listen(port, () => { server.close() })
