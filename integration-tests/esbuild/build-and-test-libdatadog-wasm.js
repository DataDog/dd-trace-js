#!/usr/bin/env node
'use strict'

const esbuild = require('esbuild')

const ddPlugin = require('../../esbuild')
const testLibdatadogWasmBundle = require('../helpers/libdatadog-wasm-bundle')

/**
 * @param {string} entry
 * @param {string} output
 * @param {boolean} [external]
 */
async function bundle (entry, output, external) {
  await esbuild.build({
    absWorkingDir: process.cwd(),
    bundle: true,
    entryPoints: [entry],
    external: external ? ['@datadog/libdatadog-wasm'] : [],
    outfile: output,
    platform: 'node',
    plugins: [ddPlugin],
  })
}

testLibdatadogWasmBundle(bundle)
