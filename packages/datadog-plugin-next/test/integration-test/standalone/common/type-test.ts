import withDatadogConfig = require('dd-trace/next')

import type { NextConfig } from 'next'

const config: NextConfig = withDatadogConfig({
  output: 'standalone',
}, {
  projectRoot: __dirname,
})

void config
