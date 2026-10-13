'use strict'

const projects = [
  { retries: 0, metadata: { retrySource: 'automatic' } },
  { retries: 1, metadata: { retrySource: 'native' } },
]
for (const project of projects) {
  if (process.env.PLAYWRIGHT_PROJECT_NAMES !== 'unnamed') {
    project.name = process.env.PLAYWRIGHT_PROJECT_NAMES === 'duplicate' ? 'same' : project.metadata.retrySource
  }
}
if (process.env.PLAYWRIGHT_NATIVE_FIRST === 'true') projects.reverse()

module.exports = {
  testDir: '.',
  testMatch: 'playwright-projects.js',
  fullyParallel: true,
  workers: 4,
  projects,
}
