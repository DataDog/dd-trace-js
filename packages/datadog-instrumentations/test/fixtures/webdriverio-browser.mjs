async function url3 (path, options = {}) {
  if (this.isBidi) {
    await this.getWindowHandle()
    return this.navigateTo(path, options)
  }
  return this.navigateTo(path)
}

export { url3 }
