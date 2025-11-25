'use strict'

const { registerLambdaHook } = require('./runtime/ritm')
const { getResolvedEnv } = require('../config-env-sources')

/**
 * It is safe to do it this way, since customers will never be expected to disable
 * this specific instrumentation through the init config object.
 */
const _DD_TRACE_DISABLED_INSTRUMENTATIONS = getResolvedEnv('DD_TRACE_DISABLED_INSTRUMENTATIONS') || ''
const _disabledInstrumentations = new Set(
  _DD_TRACE_DISABLED_INSTRUMENTATIONS ? _DD_TRACE_DISABLED_INSTRUMENTATIONS.split(',') : []
)

if (!_disabledInstrumentations.has('lambda')) {
  registerLambdaHook()
}
