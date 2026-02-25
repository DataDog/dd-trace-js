import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ddPlugin from 'dd-trace/esbuild.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const entryPoint = path.join(__dirname, 'app.mjs')

export default {
  entryPoints: [entryPoint],
  bundle: true,
  minify: false,
  format: 'esm',
  plugins: [ddPlugin],
  platform: 'node',
  target: ['node18'],
  external: [
    '@datadog/native-iast-taint-tracking',
    '@datadog/wasm-js-rewriter',
    '@openfeature/server-sdk',
  ],
}
