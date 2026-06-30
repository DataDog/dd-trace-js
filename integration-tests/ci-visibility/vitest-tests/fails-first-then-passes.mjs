import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

let attempt = 0

const attemptFile = path.join(process.cwd(), '.vitest-retry-attempt')

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function nextAttempt () {
  if (process.env.PERSIST_RETRY_ATTEMPTS !== '1') {
    return attempt++
  }

  const currentAttempt = fs.existsSync(attemptFile)
    ? Number.parseInt(fs.readFileSync(attemptFile, 'utf8'), 10)
    : 0
  fs.writeFileSync(attemptFile, String(currentAttempt + 1))
  return currentAttempt
}

describe('efd with manual vitest retries', () => {
  test('fails first then passes', async () => {
    const currentAttempt = nextAttempt()

    if (process.env.SLOW_FAILED_ATTEMPTS === '1' && currentAttempt < 2) {
      await delay(750)
    }

    if (process.env.ALWAYS_FAIL_WITH_ATTEMPT_ERROR === '1') {
      throw new Error(`failure ${currentAttempt}`)
    }

    expect(currentAttempt).to.equal(2)
  })
})
