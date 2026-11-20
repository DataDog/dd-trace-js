import tracer from 'dd-trace'
import { createRequire } from 'node:module'

import finish from '../finish.js'

const require = createRequire(import.meta.url)
const pino = require('pino')
const { default: imported } = await import('pino')

if (imported !== pino) throw new Error('pino import does not match require')

const logger = imported()

tracer.trace('bun.pino', () => logger.info('esm log'))

finish()
