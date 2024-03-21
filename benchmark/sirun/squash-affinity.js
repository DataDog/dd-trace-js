#!/usr/bin/env node

'use strict'

const fs = require('fs')
const path = require('path')

const metaJson = require(path.join(process.cwd(), 'meta.json'))

if (process.env.ENABLE_AFFINITY) {
  squashAffinity(metaJson)

  if (metaJson.variants) {
    const variants = metaJson.variants

    for (const variantName in variants) {
      const variant = variants[variantName]
      squashAffinity(variant)
    }
  }
}

function squashAffinity (obj) {
  if (obj.run_with_affinity) {
    obj.run = obj.run_with_affinity
    delete obj.run_with_affinity
  }

  if (obj.setup_with_affinity) {
    obj.setup = obj.setup_with_affinity
    delete obj.setup_with_affinity
  }
}

fs.writeFileSync(path.join(process.cwd(), 'meta-temp.json'), JSON.stringify(metaJson, null, 2))
