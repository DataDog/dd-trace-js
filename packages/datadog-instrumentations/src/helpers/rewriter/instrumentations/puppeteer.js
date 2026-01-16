'use strict'

module.exports = [
  {
    module: {
      name: 'puppeteer',
      versionRange: '>=24.35.0',
      filePath: 'lib/cjs/puppeteer/node/PuppeteerNode.js'
    },
    functionQuery: {
      methodName: 'launch',
      className: 'PuppeteerNode',
      kind: 'Async'
    },
    channelName: 'PuppeteerNode_launch'
  },
  {
    module: {
      name: 'puppeteer',
      versionRange: '>=24.35.0',
      filePath: 'lib/cjs/puppeteer/cdp/Frame.js'
    },
    functionQuery: {
      methodName: 'goto',
      className: 'CdpFrame',
      kind: 'Async'
    },
    channelName: 'CdpFrame_goto'
  },
  {
    module: {
      name: 'puppeteer',
      versionRange: '>=24.35.0',
      filePath: 'lib/cjs/puppeteer/api/Page.js'
    },
    functionQuery: {
      methodName: 'screenshot',
      className: 'Page',
      kind: 'Async'
    },
    channelName: 'Page_screenshot'
  },
  {
    module: {
      name: 'puppeteer',
      versionRange: '>=24.35.0',
      filePath: 'lib/cjs/puppeteer/api/Page.js'
    },
    functionQuery: {
      methodName: 'evaluate',
      className: 'Page',
      kind: 'Async'
    },
    channelName: 'Page_evaluate'
  },
  {
    module: {
      name: 'puppeteer',
      versionRange: '>=24.35.0',
      filePath: 'lib/cjs/puppeteer/api/Page.js'
    },
    functionQuery: {
      methodName: 'click',
      className: 'Page',
      kind: 'Async'
    },
    channelName: 'Page_click'
  },
  {
    module: {
      name: 'puppeteer',
      versionRange: '>=24.35.0',
      filePath: 'lib/cjs/puppeteer/api/Page.js'
    },
    functionQuery: {
      methodName: 'type',
      className: 'Page',
      kind: 'Async'
    },
    channelName: 'Page_type'
  },
  {
    module: {
      name: 'puppeteer',
      versionRange: '>=24.35.0',
      filePath: 'lib/cjs/puppeteer/api/Page.js'
    },
    functionQuery: {
      methodName: 'waitForSelector',
      className: 'Page',
      kind: 'Async'
    },
    channelName: 'Page_waitForSelector'
  },
  {
    module: {
      name: 'puppeteer',
      versionRange: '>=24.35.0'
    },
    functionQuery: {
      methodName: 'newPage',
      className: 'Browser',
      kind: 'Async'
    },
    channelName: 'Browser_newPage'
  },
  {
    module: {
      name: 'puppeteer',
      versionRange: '>=24.35.0'
    },
    functionQuery: {
      methodName: 'close',
      className: 'Browser',
      kind: 'Async'
    },
    channelName: 'Browser_close'
  },
  {
    module: {
      name: 'puppeteer',
      versionRange: '>=24.35.0',
      filePath: 'lib/cjs/puppeteer/cdp/Frame.js'
    },
    functionQuery: {
      methodName: 'setContent',
      className: 'CdpFrame',
      kind: 'Async'
    },
    channelName: 'CdpFrame_setContent'
  },
  {
    module: {
      name: 'puppeteer',
      versionRange: '>=24.35.0',
      filePath: 'lib/cjs/puppeteer/cdp/Frame.js'
    },
    functionQuery: {
      methodName: 'waitForNavigation',
      className: 'CdpFrame',
      kind: 'Async'
    },
    channelName: 'CdpFrame_waitForNavigation'
  }
]
