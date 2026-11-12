'use strict'

module.exports = class {
  /** @param {import('@playwright/test').FullConfig} config Playwright's resolved configuration */
  onBegin (config) {
    const projects = config.projects.map(({ name, use: { screenshot, video } }) => ({ name, screenshot, video }))
    // eslint-disable-next-line no-console
    console.log(`FAILURE_MEDIA_CONFIG=${JSON.stringify(projects)}`)
  }
}
