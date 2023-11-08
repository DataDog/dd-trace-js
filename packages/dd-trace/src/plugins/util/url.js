const { URL } = require('url')

function filterSensitiveInfoFromRepository (repositoryUrl) {
  if (!repositoryUrl) {
    return ''
  }
  if (repositoryUrl.startsWith('git@')) {
    return repositoryUrl
  }

  // Remove the username from ssh URLs
  if (repositoryUrl.startsWith('ssh://')) {
    const sshRegex = /^(ssh:\/\/)[^@/]*@/
    return repositoryUrl.replace(sshRegex, '$1')
  }

  try {
    const { protocol, host, pathname } = new URL(repositoryUrl)

    return `${protocol}//${host}${pathname === '/' ? '' : pathname}`
  } catch (e) {
    return ''
  }
}

module.exports = { filterSensitiveInfoFromRepository }
