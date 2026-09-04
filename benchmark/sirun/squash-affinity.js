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

const metaJson = require(path.join(process.cwd(), 'meta.json'))
const nodeMajor = process.env.MAJOR_VERSION ?? process.versions.node.split('.')[0]

prepareMeta(metaJson)

/**
 * Resolves runner-only metadata before Sirun reads the generated file.
 *
 * @param {BenchmarkMeta} meta
 * @returns {void}
 */
function prepareMeta (meta) {
  const operations = meta.operations_by_node?.[nodeMajor]
  if (operations !== undefined) {
    meta.env ??= {}
    meta.env.OPERATIONS = operations
  }
  delete meta.operations_by_node

  if (process.env.ENABLE_AFFINITY) {
    squashAffinity(meta)
  }

  for (const variant of Object.values(meta.variants ?? {})) {
    prepareMeta(variant)
  }
}

/**
 * Selects commands that pin the benchmark to its allocated CPU cores.
 *
 * @param {BenchmarkMeta} meta
 * @returns {void}
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

fs.writeFileSync(path.join(process.cwd(), 'meta-temp.json'), JSON.stringify(metaJson, null, 2))
