#!/usr/bin/env node

import esbuild from 'esbuild'

import commonConfig from './build.esm.common-config.js'

await esbuild.build(commonConfig)
