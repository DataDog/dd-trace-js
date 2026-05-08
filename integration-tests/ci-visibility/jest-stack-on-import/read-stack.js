'use strict'

const stack = new Error('stack from module import').stack

if (!stack.includes('stack from module import')) {
  throw new Error('Expected stack to include the original error message')
}

module.exports = stack
