#!/usr/bin/env node

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import esbuild from 'esbuild'

import ddPlugin from 'dd-trace/esbuild.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const format = process.argv[2]

// Bundled dd-trace is CommonJS, so ESM output needs the CommonJS globals it relies on.
const esmBanner = [
  "import { createRequire } from 'node:module'",
  "import { dirname as __ddDirname } from 'node:path'",
  "import { fileURLToPath as __ddFileURLToPath } from 'node:url'",
  'const require = createRequire(import.meta.url)',
  'const __filename = __ddFileURLToPath(import.meta.url)',
  'const __dirname = __ddDirname(__filename)',
].join(';')

await esbuild.build({
  entryPoints: [path.join(__dirname, 'builtins-app.mjs')],
  outfile: path.join(__dirname, `builtins-out.${format === 'esm' ? 'mjs' : 'cjs'}`),
  bundle: true,
  platform: 'node',
  target: 'node18',
  format,
  plugins: [ddPlugin],
  ...(format === 'esm' && { banner: { js: esmBanner } }),
  external: [
    '@datadog/native-metrics',
    '@datadog/pprof',
    '@datadog/native-appsec',
    '@datadog/native-iast-taint-tracking',
    '@datadog/native-iast-rewriter',
    '@openfeature/server-sdk',
  ],
})
