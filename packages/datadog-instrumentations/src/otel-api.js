'use strict'

const { addHook } = require('./helpers/instrument')

/** @type {typeof import('@opentelemetry/api') | undefined} */
exports.api = undefined
addHook({ name: '@opentelemetry/api', versions: ['*'], patchDefault: false },
  /** @param {typeof import('@opentelemetry/api')} api */
  api => {
    exports.api ??= api
    return api
  })
