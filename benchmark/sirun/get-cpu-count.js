#!/usr/bin/env node

'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const meta = require(path.join(process.cwd(), 'meta.json'))
const variant = meta.variants?.[process.env.SIRUN_VARIANT]
const cpuCount = variant?.cpus ?? 1

assert.ok(cpuCount === 1 || cpuCount === 2, 'cpus must be either 1 or 2')
process.stdout.write(String(cpuCount))
