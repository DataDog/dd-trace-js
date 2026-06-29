'use strict'

const ts = require('typescript')

module.exports = {
  process (sourceText, sourcePath) {
    const output = ts.transpileModule(sourceText, {
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2019,
      },
      fileName: sourcePath,
    })

    return { code: output.outputText }
  },
}
