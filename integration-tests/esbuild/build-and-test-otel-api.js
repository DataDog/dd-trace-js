#!/usr/bin/env node
'use strict'

const esbuild = require('esbuild')

const ddPlugin = require('../../esbuild')
const {
  EXTERNALS,
  runOtelApiBundleScenario,
} = require('../helpers/otel-api-bundle')

/**
 * @param {{ entry: string, outfile: string, workingDirectory: string }} paths
 * @param {'cjs' | 'esm'} format
 */
function build (paths, format) {
  return esbuild.build({
    absWorkingDir: paths.workingDirectory,
    bundle: true,
    entryPoints: [paths.entry],
    external: [...EXTERNALS, '@opentelemetry/*'],
    format,
    outfile: paths.outfile,
    platform: 'node',
    plugins: [ddPlugin],
    target: 'node18',
  })
}

async function main () {
  for (const [format, extension] of [['cjs', 'js'], ['esm', 'mjs']]) {
    for (const applicationOwnsApi of [false, true]) {
      await runOtelApiBundleScenario({
        applicationOwnsApi,
        build: paths => build(paths, /** @type {'cjs' | 'esm'} */ (format)),
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
