'use strict'

if (process.env.USE_INTERNAL_TRACER_BUNDLE === '1') {
  const webpack = require('webpack')

  const config = {
    entry: [`${__dirname}/internal.js`],
    target: 'node',
    mode: 'production',
    output: {
      path: `${__dirname}/dist`,
      filename: 'internal.js',
      libraryTarget: 'umd'
    }
  }

  webpack(config, (err, stats) => {
    if (err) {
      throw err
    }

    if (stats.hasErrors()) {
      console.error(stats.toString()) // eslint-disable-line no-console
    }
  })
}
