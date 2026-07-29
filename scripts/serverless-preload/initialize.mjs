import * as Module from 'node:module'

import '../../init.js'
import tracer from '../../index.js'

globalThis[Symbol.for('datadog:serverless:tracer')] = tracer

if (Module.register) {
  Module.register('./loader-hook.mjs', import.meta.url)
}
