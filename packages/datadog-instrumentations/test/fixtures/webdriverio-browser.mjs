async function url3 (path, options = {}) {
  if (this.isBidi) {
    await this.getWindowHandle()
    return this.navigateTo(path, options)
  }
  return this.navigateTo(path)
}

async function newWindow3 (path) {
  if (this.isBidi) {
    const { context } = await this.browsingContextCreate({ type: 'window' })
    await this.browsingContextNavigate({ context, url: path })
    await this.switchToWindow(context)
  }
}

export { newWindow3, url3 }
