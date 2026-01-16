'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class BasePuppeteerClientPlugin extends ClientPlugin {
  static id = 'puppeteer'
  static prefix = 'tracing:orchestrion:puppeteer:PuppeteerNode_launch'

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan('launch', {
      service: this.serviceName({ pluginService: this.config.service }),
      meta
    }, ctx)

    return ctx.currentStore
  }

  getTags (ctx) {
    return {
      component: 'puppeteer',
      'span.kind': 'client'
    }
  }

  // asyncEnd and end delegate to finish() which has the required guard
  asyncEnd (ctx) {
    this.finish(ctx)
  }

  end (ctx) {
    this.finish(ctx)
  }

  // You may modify this method, but the guard below is REQUIRED and MUST NOT be removed!
  finish (ctx) {
    // CRITICAL GUARD - DO NOT REMOVE: Ensures span only finishes when operation completes
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    super.finish(ctx)
  }
}

class CdpFrameGotoPlugin extends BasePuppeteerClientPlugin {
  static prefix = 'tracing:orchestrion:puppeteer:CdpFrame_goto'
}

class PageScreenshotPlugin extends BasePuppeteerClientPlugin {
  static prefix = 'tracing:orchestrion:puppeteer:Page_screenshot'
}

class PageEvaluatePlugin extends BasePuppeteerClientPlugin {
  static prefix = 'tracing:orchestrion:puppeteer:Page_evaluate'
}

class PageClickPlugin extends BasePuppeteerClientPlugin {
  static prefix = 'tracing:orchestrion:puppeteer:Page_click'
}

class PageTypePlugin extends BasePuppeteerClientPlugin {
  static prefix = 'tracing:orchestrion:puppeteer:Page_type'
}

class PageWaitForSelectorPlugin extends BasePuppeteerClientPlugin {
  static prefix = 'tracing:orchestrion:puppeteer:Page_waitForSelector'
}

class BrowserNewPagePlugin extends BasePuppeteerClientPlugin {
  static prefix = 'tracing:orchestrion:puppeteer:Browser_newPage'
}

class BrowserClosePlugin extends BasePuppeteerClientPlugin {
  static prefix = 'tracing:orchestrion:puppeteer:Browser_close'
}

class CdpFrameSetContentPlugin extends BasePuppeteerClientPlugin {
  static prefix = 'tracing:orchestrion:puppeteer:CdpFrame_setContent'
}

class CdpFrameWaitForNavigationPlugin extends BasePuppeteerClientPlugin {
  static prefix = 'tracing:orchestrion:puppeteer:CdpFrame_waitForNavigation'
}

module.exports = {
  'BasePuppeteerClientPlugin': BasePuppeteerClientPlugin,
  'CdpFrameGotoPlugin': CdpFrameGotoPlugin,
  'PageScreenshotPlugin': PageScreenshotPlugin,
  'PageEvaluatePlugin': PageEvaluatePlugin,
  'PageClickPlugin': PageClickPlugin,
  'PageTypePlugin': PageTypePlugin,
  'PageWaitForSelectorPlugin': PageWaitForSelectorPlugin,
  'BrowserNewPagePlugin': BrowserNewPagePlugin,
  'BrowserClosePlugin': BrowserClosePlugin,
  'CdpFrameSetContentPlugin': CdpFrameSetContentPlugin,
  'CdpFrameWaitForNavigationPlugin': CdpFrameWaitForNavigationPlugin
}
