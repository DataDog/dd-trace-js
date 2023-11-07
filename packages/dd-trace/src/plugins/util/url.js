const { URL } = require('url')

function filterSensitiveInfoFromRepository (repositoryUrl) {
  if (repositoryUrl.startsWith('git@')) {
    return repositoryUrl
  }

  // Remove the username from ssh URLs
  if (repositoryUrl.startsWith('ssh://')) {
    const sshRegex = /^(ssh:\/\/)[^@/]*@/
    return repositoryUrl.replace(sshRegex, '$1')
  }

  try {
    const { protocol, hostname, pathname } = new URL(repositoryUrl)

    return `${protocol}//${hostname}${pathname === '/' ? '' : pathname}`
  } catch (e) {
    return ''
  }
}

module.exports = { filterSensitiveInfoFromRepository }
