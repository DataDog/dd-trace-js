'use strict'

/* eslint-disable require-await */

const shimmer = require('../../../packages/datadog-shimmer')

const {
  ENABLED,
  WRAP_FUNCTION,
  FUNCTION_NAME
} = process.env

const ITERATIONS = 2e6

let counter = 0
function declared () {
  return ++counter // Do very little
}

const arrow = () => {
  return ++counter // Do very little
}

async function asyncDeclared () {
  return ++counter // Do very little
}

const asyncArrow = async () => {
  return ++counter // Do very little
}

const testedFn = {
  declared,
  arrow,
  asyncDeclared,
  asyncArrow
}[FUNCTION_NAME]
if (!testedFn) {
  throw new Error(`Function ${FUNCTION_NAME} not found`)
}

if (ENABLED !== 'true') {
  for (let i = 0; i < ITERATIONS; i++) {
    testedFn()
  }
} else {
  if (WRAP_FUNCTION === 'true') {
    const wrapped = shimmer.wrapFunction(testedFn, (original) => {
      return function () {
        return original.apply(this, arguments)
      }
    })
    for (let i = 0; i < ITERATIONS; i++) {
      wrapped()
    }
  } else {
    const obj = {
      testedFn
    }
    shimmer.wrap(obj, 'testedFn', (original) => {
      return function () {
        return original.apply(this, arguments)
      }
    })
    const wrapped = obj.testedFn
    for (let i = 0; i < ITERATIONS; i++) {
      wrapped()
    }
  }
}
