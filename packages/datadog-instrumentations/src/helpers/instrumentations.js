'use strict'

const sym = Symbol.for('_ddtrace_instrumentations')

global[sym] = global[sym] || {}

/** @template T */
/**
 * @typedef {(moduleExports: T, version: string) => T} Hook
 *
 * @type {Record<string, Instrumentation[]>}
 * @typedef {Object} Instrumentation
 * @property {string[]} [versions]
 * @property {string} [file]
 * @property {string} [filePattern]
 * @property {Hook} hook
 * @property {boolean} [patchDefault]
 */
module.exports = global[sym]
