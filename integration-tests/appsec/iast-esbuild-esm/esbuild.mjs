/* eslint-disable no-console */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import esbuild from 'esbuild'

import esbuildCommonConfig from './esbuild.common-config.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outfileWithSm = path.join(__dirname, 'build', 'iast-enabled-with-sm.mjs')

esbuild.build({
  ...esbuildCommonConfig,
  outfile: 'build/iast-enabled-with-sm.mjs', //outfileWithSm,
  sourcemap: true,
}).catch((err) => {
  console.error(err)
  process.exit(1)
})

const outfileWithoutSm = path.join(__dirname, 'build', 'iast-enabled-with-no-sm.mjs')

esbuild.build({
  ...esbuildCommonConfig,
  outfile: 'build/iast-enabled-with-no-sm.mjs', //outfileWithoutSm,
  sourcemap: false,
}).catch((err) => {
  console.error(err)
  process.exit(1)
})

