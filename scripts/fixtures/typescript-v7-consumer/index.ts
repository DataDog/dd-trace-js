import tracer, { type TracerOptions } from 'dd-trace'
import { HTTP_HEADERS } from 'dd-trace/ext/formats'

const options: TracerOptions = { service: 'bundled-consumer' }
tracer.init(options).trace('operation', () => HTTP_HEADERS)
