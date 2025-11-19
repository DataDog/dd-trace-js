import * as Fastify from 'fastify'
import { createAndStartServer } from './helper.mjs'

const app = Fastify.default()

createAndStartServer(app)
