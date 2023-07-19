import tracer from 'dd-trace'
import Fastify from 'fastify'
import { createAndStartServer } from './helper.mjs'

tracer.init({ port: process.env.AGENT_PORT })

const app = Fastify.default()

createAndStartServer(app)
