'use strict'

const webpack = require('webpack')

const config = {
  entry: [`${__dirname}/../../../packages/datadog-tracer/index.js`],
  target: 'node',
  mode: 'production',
  output: {
    path: `${__dirname}/dist`,
    filename: 'tracer.js',
    libraryTarget: 'umd'
  }
}

webpack(config, (err, stats) => {
  if (err) {
    throw err
  }

  if (stats.hasError()) {
    console.error(stats.toString()) // eslint-disable-line no-console
  }
})
