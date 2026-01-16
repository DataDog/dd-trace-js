'use strict'

class PuppeteerTestSetup {
  async setup (module) {
    this.browser = null
    this.page = null
    // Launch browser is done in puppeteerNodeLaunch operation
  }

  async teardown () {
    if (this.browser) {
      // CdpBrowser.close - this calls the concrete CdpBrowser class close method
      await this.browser.close()
    }
  }

  // --- Operations ---
  async puppeteerNodeLaunch () {
    try {
      this.browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      })
      return this.browser
    } catch (error) {
      throw error
    }
  }

  async pageScreenshot () {
    try {
      if (!this.page) {
        await this.cdpBrowserNewPage()
      }
      await this.pageSetContent()
      const screenshot = await this.page.screenshot({
        type: 'png',
        fullPage: true
      })
      return screenshot
    } catch (error) {
      throw error
    }
  }

  async pageScreenshotError () {
    try {
      if (!this.page) {
        await this.cdpBrowserNewPage()
      }
      // Try to save screenshot to invalid path
      await this.page.screenshot({
        path: '/nonexistent/directory/screenshot.png'
      })
    } catch (error) {
      throw error
    }
  }

  async pageEvaluate () {
    try {
      if (!this.page) {
        await this.cdpBrowserNewPage()
      }
      await this.pageSetContent()
      const result = await this.page.evaluate(() => {
        const heading = document.querySelector('#heading')
        return heading ? heading.textContent : null
      })
      return result
    } catch (error) {
      throw error
    }
  }

  async pageEvaluateError () {
    try {
      if (!this.page) {
        await this.cdpBrowserNewPage()
      }
      // Try to evaluate code that throws an error
      await this.page.evaluate(() => {
        throw new Error('Intentional evaluation error')
      })
    } catch (error) {
      throw error
    }
  }

  async pageClick () {
    try {
      if (!this.page) {
        await this.cdpBrowserNewPage()
      }
      // Ensure we have content with a clickable element
      await this.pageSetContent()
      await this.page.click('#submit-btn')
    } catch (error) {
      throw error
    }
  }

  async pageClickError () {
    try {
      if (!this.page) {
        await this.cdpBrowserNewPage()
      }
      // Try to click on non-existent element
      await this.page.click('#nonexistent-element', { timeout: 1000 })
    } catch (error) {
      throw error
    }
  }

  async pageType () {
    try {
      if (!this.page) {
        await this.cdpBrowserNewPage()
      }
      await this.pageSetContent()
      await this.page.type('#input-field', 'Hello from Puppeteer!')
    } catch (error) {
      throw error
    }
  }

  async pageTypeError () {
    try {
      if (!this.page) {
        await this.cdpBrowserNewPage()
      }
      // Try to type into non-existent element
      await this.page.type('#nonexistent-input', 'test', { timeout: 1000 })
    } catch (error) {
      throw error
    }
  }

  async pageWaitForSelector () {
    try {
      if (!this.page) {
        await this.cdpBrowserNewPage()
      }
      await this.pageSetContent()
      const element = await this.page.waitForSelector('#heading', { timeout: 5000 })
      return element
    } catch (error) {
      throw error
    }
  }

  async pageWaitForSelectorError () {
    try {
      if (!this.page) {
        await this.cdpBrowserNewPage()
      }
      // Try to wait for non-existent element with short timeout
      await this.page.waitForSelector('#never-going-to-exist', { timeout: 100 })
    } catch (error) {
      throw error
    }
  }
}

module.exports = PuppeteerTestSetup
