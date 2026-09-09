import path from 'node:path'
import { fileURLToPath } from 'node:url'

import webpack from 'webpack'

import DatadogWebpackPlugin from '../../../webpack.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const projectDir = path.dirname(dirname)
const compiler = webpack({
  mode: 'development',
  entry: path.join(dirname, 'hono.mjs'),
  target: 'node',
  externalsType: 'commonjs',
  output: {
    filename: 'hono-out.cjs',
    path: projectDir,
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

/**
 * @param {(value?: unknown) => void} resolve
 * @param {(reason?: unknown) => void} reject
 */
function runCompiler (resolve, reject) {
  /**
   * @param {Error|null} error
   * @param {import('webpack').Stats} stats
   */
  function finishCompilation (error, stats) {
    if (error) return reject(error)
    if (stats.hasErrors()) return reject(new Error(stats.toString({ errors: true })))
    resolve()
  }

  compiler.run(finishCompilation)
}

await new Promise(runCompiler)
