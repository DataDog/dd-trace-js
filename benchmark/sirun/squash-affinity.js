#!/usr/bin/env node

'use strict'

const fs = require('fs')
const path = require('path')

/**
 * @typedef {object} BenchmarkMeta
 * @property {Record<string, string>} [env]
 * @property {Record<string, string>} [operations_by_node]
 * @property {string} [run]
 * @property {string} [run_with_affinity]
 * @property {string} [setup]
 * @property {string} [setup_with_affinity]
 * @property {Record<string, BenchmarkMeta>} [variants]
 */

/**
 * Resolves runner-only metadata before Sirun reads the generated file.
 *
 * @param {BenchmarkMeta} meta
 * @param {object} [options]
 * @param {boolean} [options.enableAffinity]
 * @param {string} [options.nodeMajor]
 */
function prepareMeta (meta, options = {}) {
  const nodeMajor = options.nodeMajor ?? process.env.MAJOR_VERSION ?? process.versions.node.split('.')[0]
  const enableAffinity = options.enableAffinity ?? Boolean(process.env.ENABLE_AFFINITY)

  prepareNestedMeta(meta, nodeMajor, enableAffinity)
}

/**
 * @param {BenchmarkMeta} meta
 * @param {string} nodeMajor
 * @param {boolean} enableAffinity
 */
function prepareNestedMeta (meta, nodeMajor, enableAffinity) {
  const operations = meta.operations_by_node?.[nodeMajor]
  if (operations !== undefined) {
    meta.env ??= {}
    meta.env.OPERATIONS = operations
  }
  delete meta.operations_by_node

  meta.run = addExposeGc(meta.run)
  meta.run_with_affinity = addExposeGc(meta.run_with_affinity)

  if (enableAffinity) {
    squashAffinity(meta)
  }

  for (const variant of Object.values(meta.variants ?? {})) {
    prepareNestedMeta(variant, nodeMajor, enableAffinity)
  }
}

/**
 * @param {string} [command]
 */
function addExposeGc (command) {
  if (command === undefined || command.includes('--expose-gc')) return command
  return command.replace(/(^|\s)node(?=\s)/, '$1node --expose-gc')
}

/**
 * Selects commands that pin the benchmark to its allocated CPU cores.
 *
 * @param {BenchmarkMeta} meta
 */
function squashAffinity (meta) {
  if (meta.run_with_affinity) {
    meta.run = meta.run_with_affinity
    delete meta.run_with_affinity
  }

  if (meta.setup_with_affinity) {
    meta.setup = meta.setup_with_affinity
    delete meta.setup_with_affinity
  }
}

function prepareMetaFile () {
  const metaJson = require(path.join(process.cwd(), 'meta.json'))
  prepareMeta(metaJson)
  fs.writeFileSync(path.join(process.cwd(), 'meta-temp.json'), JSON.stringify(metaJson, null, 2))
}

if (require.main === module) prepareMetaFile()

module.exports = { addExposeGc, prepareMeta, prepareMetaFile }
