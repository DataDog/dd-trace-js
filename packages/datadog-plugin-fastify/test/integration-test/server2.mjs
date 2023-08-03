import 'dd-trace/init.js'
import Fastify from 'fastify'
import { createAndStartServer } from './helper.mjs'

const app = Fastify.default()

createAndStartServer(app)
