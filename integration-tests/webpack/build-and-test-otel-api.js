#!/usr/bin/env node
'use strict'

const path = require('node:path')

const webpack = require('webpack')

const {
  EXTERNALS,
  runOtelApiBundleScenario,
} = require('../helpers/otel-api-bundle')
const DatadogWebpackPlugin = require('../../webpack')

/**
 * @param {{ entry: string, outfile: string, workingDirectory: string }} paths
 * @param {boolean} outputModule
 * @returns {Promise<void>}
 */
function build (paths, outputModule) {
  return new Promise((resolve, reject) => {
    const externals = { '@opentelemetry/api': 'module @opentelemetry/api' }
    const externalType = outputModule ? 'node-commonjs' : 'commonjs'
    for (const name of EXTERNALS) {
      externals[name] = `${externalType} ${name}`
    }

    webpack({
      context: paths.workingDirectory,
      devtool: false,
      entry: paths.entry,
      experiments: { outputModule },
      externals,
      externalsType: outputModule ? 'module' : 'commonjs',
      mode: 'development',
      optimization: { minimize: false },
      output: {
        filename: path.basename(paths.outfile),
        hashFunction: 'sha256',
        module: outputModule,
        path: path.dirname(paths.outfile),
      },
      plugins: [new DatadogWebpackPlugin()],
      target: 'node18',
    }, (error, stats) => {
      if (error) return reject(error)
      if (stats.hasErrors()) return reject(new Error(stats.toString({ errors: true })))
      resolve()
    })
  })
}

async function main () {
  for (const [outputModule, extension] of [[false, 'js'], [true, 'mjs']]) {
    for (const applicationOwnsApi of [false, true]) {
      await runOtelApiBundleScenario({
        applicationOwnsApi,
        build: paths => build(paths, outputModule),
        extension,
      })
    }
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
