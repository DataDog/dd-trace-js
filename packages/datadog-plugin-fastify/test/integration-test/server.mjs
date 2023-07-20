import 'dd-trace/init.js'
import fastify from 'fastify'
import { createAndStartServer } from './helper.mjs'

const app = fastify()

createAndStartServer(app)
