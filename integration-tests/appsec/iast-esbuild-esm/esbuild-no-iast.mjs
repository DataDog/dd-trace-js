/* eslint-disable no-console */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import esbuild from 'esbuild'

import esbuildCommonConfig from './esbuild.common-config.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outfile = path.join(__dirname, 'build', 'iast-disabled.mjs')

esbuild.build({
  ...esbuildCommonConfig,
  outfile,
  sourcemap: false
}).catch((err) => {
  console.error(err)
  process.exit(1)
})

