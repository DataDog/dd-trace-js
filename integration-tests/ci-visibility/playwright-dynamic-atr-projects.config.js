'use strict'

const projects = [
  { retries: 0, metadata: { retrySource: 'automatic' } },
  { retries: 3, metadata: { retrySource: 'native' } },
]

if (process.env.PLAYWRIGHT_PROJECT_NAME) {
  for (const project of projects) project.name = process.env.PLAYWRIGHT_PROJECT_NAME
}
if (process.env.PLAYWRIGHT_NATIVE_PROJECT_FIRST) projects.reverse()

module.exports = {
  testDir: './playwright-dynamic-atr',
  testMatch: '**/*-test.js',
  projects,
}
