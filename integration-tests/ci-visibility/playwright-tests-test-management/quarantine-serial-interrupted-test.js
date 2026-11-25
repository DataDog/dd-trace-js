'use strict'

const { access, mkdir, writeFile } = require('node:fs/promises')
const path = require('node:path')

const { test, expect } = require('@playwright/test')

test.describe.parallel('quarantine interruption', () => {
  test.describe.serial('retried group', () => {
    // No fixtures are needed; Playwright requires a destructured first parameter.
    // eslint-disable-next-line no-empty-pattern
    test('prerequisite', async ({}, testInfo) => {
      if (testInfo.retry === 0) return
      await mkdir(testInfo.project.outputDir, { recursive: true })
      await writeFile(path.join(testInfo.project.outputDir, 'retry-started'), '')
      await new Promise(() => {})
    })

    test('quarantined failure', async () => {
      expect(true).toBe(false)
    })

    test('did not run', async () => {})
  })

  test.describe.serial('fail-fast group', () => {
    test.describe.configure({ retries: 0 })
    // eslint-disable-next-line no-empty-pattern
    test('quarantined failure', async ({}, testInfo) => {
      await expect.poll(async () => {
        try {
          await access(path.join(testInfo.project.outputDir, 'retry-started'))
          return true
        } catch {
          return false
        }
      }).toBe(true)
      expect(true).toBe(false)
    })

    test('did not run', async () => {})
  })
})
