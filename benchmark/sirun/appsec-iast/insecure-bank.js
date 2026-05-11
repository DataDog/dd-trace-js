'use strict'

const http = require('http')

const { port } = require('./common')
const loadInsecureBank = require('../load-insecure-bank')

const app = loadInsecureBank()
app.set('port', port)
const server = http.createServer(app)

server.listen(port, () => { server.close() })
