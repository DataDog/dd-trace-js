'use strict'

const path = require('path')

const log = require('../log')
const { snapshotKinds } = require('./constants')

const oomExportStrategies = Object.freeze({
  PROCESS: 'process',
  ASYNC_CALLBACK: 'async',
  LOGS: 'logs',
})

/** @param {string} name */
function getExportStrategy (name) {
  const strategy = Object.values(oomExportStrategies).find(value => value === name)
  if (strategy === undefined) {
    log.error('Unknown oom export strategy "%s"', name)
  }
  return strategy
}

/**
 * Validates the configured strategies, dropping any the tracer does not recognize (each logged once).
 *
 * @param {string[]} strategies
 * @returns {string[]}
 */
function ensureOOMExportStrategies (strategies) {
  const valid = new Set()
  for (const strategy of strategies) {
    const resolved = getExportStrategy(strategy)
    if (resolved !== undefined) {
      valid.add(resolved)
    }
  }
  return [...valid]
}

/**
 * @param {string[]} strategies
 * @param {{ Async: number }} callbackMode
 */
function strategiesToCallbackMode (strategies, callbackMode) {
  return strategies.includes(oomExportStrategies.ASYNC_CALLBACK) ? callbackMode.Async : 0
}

/**
 * Builds the argv the near-OOM export subprocess ({@link ./exporter_cli.js}) is spawned with. Each
 * exporter reports its own destination URL, so the command stays agnostic of the exporter types.
 *
 * @param {Array<{ getExportUrl(): URL | undefined }>} exporters
 * @param {Record<string, string>} tags
 * @returns {string[]}
 */
function buildExportCommand (exporters, tags) {
  const tagString = [...Object.entries(tags),
    ['snapshot', snapshotKinds.ON_OUT_OF_MEMORY]].map(([key, value]) => `${key}:${value}`).join(',')
  const urls = []
  for (const exporter of exporters) {
    const url = exporter.getExportUrl()
    if (url !== undefined) {
      urls.push(url.toString())
    }
  }
  return [process.execPath,
    path.join(__dirname, 'exporter_cli.js'),
    urls.join(','), tagString, 'space']
}

module.exports = { oomExportStrategies, ensureOOMExportStrategies, strategiesToCallbackMode, buildExportCommand }
