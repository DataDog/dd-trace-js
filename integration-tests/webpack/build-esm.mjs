import path from 'node:path'
import { fileURLToPath } from 'node:url'

import webpack from 'webpack'

import DatadogWebpackPlugin from 'dd-trace/webpack.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const compiler = webpack({
  mode: 'development',
  entry: path.join(dirname, 'hono.mjs'),
  target: 'node',
  externalsType: 'commonjs',
  output: {
    filename: 'hono-out.cjs',
    path: dirname,
    hashFunction: 'sha256',
  },
  externals: [
    'diagnostics_channel',
    '@datadog/libdatadog',
    '@datadog/native-appsec',
    '@datadog/native-iast-rewriter',
    '@datadog/native-iast-taint-tracking',
    '@datadog/native-metrics',
    '@datadog/pprof',
    '@openfeature/server-sdk',
  ],
  plugins: [new DatadogWebpackPlugin()],
})

await new Promise((resolve, reject) => {
  compiler.run((error, stats) => {
    if (error) return reject(error)
    if (stats.hasErrors()) return reject(new Error(stats.toString({ errors: true })))
    resolve()
  })
})
