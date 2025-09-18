'use strict'

const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const tracingChannel = require('dc-polyfill').tracingChannel

const genaiChannel = tracingChannel('apm:google:genai:request')

function wrapGenerateContent (method) {
  return function wrappedGenerateContentInternal (func) {
    console.log('where are we even')
    return function (...args) {
      console.log('where are we even', args)
      if (genaiChannel.hasSubscribers) {
        const inputs = args[0]
        const promptText = inputs?.contents || ''
        const normalizedName = normalizeMethodName(method)
        console.log('normalized', normalizedName)

        const ctx = {
          methodName: normalizedName,
          inputs,
          promptText,
          model: args[0].model || 'unknown'
        }
        return genaiChannel.tracePromise(func, ctx, this, ...args)
      }

      return func.apply(this, args)
    }
  }
}

// Hook the main package entry point
addHook({
  name: '@google/genai',
  versions: ['>=1.19.0']
}, exports => {
  // Wrap GoogleGenAI to intercept when it creates Models instances
  if (exports.GoogleGenAI) {
    shimmer.wrap(exports, 'GoogleGenAI', GoogleGenAI => {
      return class extends GoogleGenAI {
        constructor (...args) {
          super(...args)

          // Wrap the models property after it's created
          if (this.models) {
            if (this.models.generateContent) {
              shimmer.wrap(this.models, 'generateContent', wrapGenerateContent('generateContent'))
            }
            if (this.models.generateContentStream) {
              shimmer.wrap(this.models, 'generateContentStream', wrapGenerateContent('generateContentStream'))
            }
            if (this.models.embedContent) {
              shimmer.wrap(this.models, 'embedContent', wrapGenerateContent('embedContent'))
            }
          }
        }
      }
    })
  }

  return exports
})
function normalizeMethodName (methodName) {
  // using regex and built-in method less verbose only slightly slower than a more
  // verbose nested loop
  return 'Models.' + methodName
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2') // insert underscore before capitals
    .toLowerCase()
}

// const extensions = ['cjs', 'mjs']
// const paths = [
//   'dist/index', // Main entry point
//   'dist/node/index' // Node-specific entry point
// ]

// for (const extension of extensions) {
//   for (const path of paths) {
//     const fullPath = `${path}.${extension}`
//     console.log('=== REGISTERING HOOK ===')
//     console.log('Extension:', extension)
//     console.log('Path:', path)
//     console.log('Full path:', fullPath)
//     console.log('Expected moduleName:', `@google/genai/${fullPath}`)

//     addHook({
//       name: '@google/genai',
//       file: fullPath,
//       versions: ['>=1.19.0']
//     }, exports => {
//       console.log('=== HOOK TRIGGERED ===')
//       console.log('Extension:', extension)
//       console.log('Path:', path)
//       console.log('Expected fullFilename:', `@google/genai/${path}.${extension}`)
//       console.log('in the hook', extension, path)
//       // if (extension === 'cjs') {
//       shimmer.wrap(exports, 'Models', Models => {
//         console.log('=== WRAPPING Models CLASS ===')
//         console.log('Models:', Models)
//         console.log('Models.prototype:', Models.prototype)
//         console.log('Models.prototype.generateContent:', typeof Models.prototype.generateContent)
//         return class extends Models {
//           constructor (...args) {
//             super(...args)
//             console.log('this.constructor.name', this.constructor.name)
//             if (this.constructor.name) {}
//             console.log('=== ABOUT TO WRAP generateContent ===')
//             shimmer.wrap(Models.prototype, 'generateContent',
//               wrapGenerateContent
// ('generateContent'))
//             console.log('=== FINISHED WRAPPING generateContent ===')
//           }
//         }
//       })
//       // }
//       return exports
//     })
//   }
// }
// function wrap (obj, name, channelName, namespace) {
//   const channel = tracingChannel(channelName)
//   shimmer.wrap(obj, name, function (original) {
//     console.log('functio wrap')
//     return function () {
//       if (!channel.start.hasSubscribers) {
//         return original.apply(this, arguments)
//       }
//       const ctx = { self: this, arguments }
//       if (namespace) {
//         ctx.namespace = namespace
//       }
//       return channel.tracePromise(original, ctx, this, ...arguments)
//     }
//   })
// }
// function normalizeGenAIResourceName (resource) {
//   switch (resource) {
//   // completions
//     case 'completions.create':
//       return 'createCompletion'

//       // chat completions
//     case 'generateContentStreamInternal':
//       return 'createChatCompletion'

//       // embeddings
//     case 'embeddings.create':
//       return 'createEmbedding'
//     default:
//       return resource
//   }
// }
// }
// const { addHook } = require('./helpers/instrument')
// const shimmer = require('../../datadog-shimmer')

// const dc = require('dc-polyfill')
// const genRequest = dc.tracingChannel('apm:gemini:request')
// console.log('in gen instru')

// function wrapGenerate (that) {
//   console.log('in generate!', arguments, that.constructor)
//   return function (...args) {
//     console.log('GENERATE', args)
//     that.constructor.apply(this, args)
//   }
// }

// addHook({
//   name: '@google/genai',
//   versions: ['>=1.19.0']
// }, gemini => {
//   // Wrap generateContent directly on the prototype
//   console.log('gemini.Models.prototype.generateContent', gemini.Models.prototype.generateContent)
//   if (gemini.Models && gemini.Models.prototype && typeof gemini.Models.prototype.generateContent === 'function') {
//     shimmer.wrap(gemini.Models.prototype, 'generateContent', function (original) {
//       return async function (...args) {
//         console.log('generateContent called with:', args)
//         const result = await original.apply(this, args)
//         console.log('generateContent returned:', result)
//         return result
//       }
//     })
//   }
// })

// if (gemini.Models &&
// gemini.Models.prototype &&
// typeof gemini.Models.prototype.generateContentInternal === 'function') {
//   shimmer.wrap(gemini.Models.prototype, 'generateContentInternal',
//     wrapGenerateContent
// ('generateContentInternal'))
// }
// if (gemini.Models &&
// gemini.Models.prototype &&
// typeof gemini.Models.prototype.generateContentStreamInternal === 'function') {
//   shimmer.wrap(gemini.Models.prototype, 'generateContentStreamInternal',
//     wrapGenerateContent
// ('generateContentStreamInternal'))
// }
