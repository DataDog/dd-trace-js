'use strict'

const { registerLambdaHook } = require('./runtime/ritm')

const _DD_TRACE_DISABLED_INSTRUMENTATIONS = process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS || ''
const _disabledInstrumentations = new Set(
  _DD_TRACE_DISABLED_INSTRUMENTATIONS ? _DD_TRACE_DISABLED_INSTRUMENTATIONS.split(',') : []
)

if (!_disabledInstrumentations.has('lambda')) {
  registerLambdaHook()
}
