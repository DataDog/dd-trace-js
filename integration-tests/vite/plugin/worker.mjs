// A second entry initializing the tracer, so a code-split build moves the tracer into a chunk shared by both entries.
import './tracer.mjs'

import { Hono } from 'hono'

export const app = new Hono()
