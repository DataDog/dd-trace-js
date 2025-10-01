'use strict'

const MODEL_TYPE_IDENTIFIERS = [
  'foundation-model/',
  'custom-model/',
  'provisioned-model/',
  'imported-module/',
  'prompt/',
  'endpoint/',
  'inference-profile/',
  'default-prompt-router/'
]

function parseModelId (modelId) {
  // Best effort to extract the model provider and model name from the bedrock model ID.
  // modelId can be a 1/2 period-separated string or a full AWS ARN, based on the following formats:
  // 1. Base model: "{model_provider}.{model_name}"
  // 2. Cross-region model: "{region}.{model_provider}.{model_name}"
  // 3. Other: Prefixed by AWS ARN "arn:aws{+region?}:bedrock:{region}:{account-id}:"
  //     a. Foundation model: ARN prefix + "foundation-model/{region?}.{model_provider}.{model_name}"
  //     b. Custom model: ARN prefix + "custom-model/{model_provider}.{model_name}"
  //     c. Provisioned model: ARN prefix + "provisioned-model/{model-id}"
  //     d. Imported model: ARN prefix + "imported-module/{model-id}"
  //     e. Prompt management: ARN prefix + "prompt/{prompt-id}"
  //     f. Sagemaker: ARN prefix + "endpoint/{model-id}"
  //     g. Inference profile: ARN prefix + "{application-?}inference-profile/{model-id}"
  //     h. Default prompt router: ARN prefix + "default-prompt-router/{prompt-id}"
  // If model provider cannot be inferred from the modelId formatting, then default to "custom"
  modelId = modelId.toLowerCase()
  if (!modelId.startsWith('arn:aws')) {
    const modelMeta = modelId.split('.')
    if (modelMeta.length < 2) {
      return { modelProvider: 'custom', modelName: modelMeta[0] }
    }
    return { modelProvider: modelMeta.at(-2), modelName: modelMeta.at(-1) }
  }

  for (const identifier of MODEL_TYPE_IDENTIFIERS) {
    if (!modelId.includes(identifier)) {
      continue
    }
    modelId = modelId.split(identifier).pop()
    if (['foundation-model/', 'custom-model/'].includes(identifier)) {
      const modelMeta = modelId.split('.')
      if (modelMeta.length < 2) {
        return { modelProvider: 'custom', modelName: modelId }
      }
      return { modelProvider: modelMeta.at(-2), modelName: modelMeta.at(-1) }
    }
    return { modelProvider: 'custom', modelName: modelId }
  }

  return { modelProvider: 'custom', modelName: 'custom' }
}

module.exports = { parseModelId }
