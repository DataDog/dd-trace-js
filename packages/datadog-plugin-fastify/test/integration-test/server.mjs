import tracer from 'dd-trace'
import fastify from 'fastify'
import { createAndStartServer } from './helper.mjs'

tracer.init({ port: process.env.AGENT_PORT })

const app = fastify()

createAndStartServer(app)
