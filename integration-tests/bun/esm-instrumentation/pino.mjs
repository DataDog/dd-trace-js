import tracer from 'dd-trace'
import pino from 'pino'

import finish from '../finish.js'

const logger = pino()

tracer.trace('bun.pino', () => logger.info('esm log'))

finish()
