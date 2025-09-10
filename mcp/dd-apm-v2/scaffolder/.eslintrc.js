module.exports = {
  extends: ['../../../.eslintrc.js'],
  rules: {
    'no-console': 'off', // CLI tools need console output
    'max-len': ['error', { code: 130 }] // Allow slightly longer lines for CLI messages
  }
}
