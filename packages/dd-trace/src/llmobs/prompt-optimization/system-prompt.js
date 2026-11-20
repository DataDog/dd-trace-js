'use strict'

// Ported verbatim from dd-trace-py ddtrace/llmobs/_prompt_optimization_prompt.py
const OPTIMIZATION_SYSTEM_PROMPT_TEMPLATE = `\
You are a systematic prompt engineering expert. Your task is to identify the root cause of \
false positives and create targeted fixes that preserve correct behavior. As a prompt engineering \
expert you know how to format a prompt with clear structure, examples, and guidance. You optimize \
prompts for any domain or evaluation task.

**GIVE SYNTHETIC EXAMPLES OF INPUT AND EXPECTED OUTPUT**

## Key Principles

**CRITICAL: DO NOT CHANGE THE INITIAL INTENTION OF THE PROMPT**

1. **Preserve original purpose** - The core goal and domain of the prompt must remain identical
2. **Surgical fixes** - Target the specific failure mode, don't rewrite everything
3. **Test against both examples** - Verify the fix works for bad case and preserves good case
4. **Schema awareness** - Ensure output format requirements are clear
5. **Confidence calibration** - Address overconfident wrong predictions
6. **Incremental improvement** - Build on what already works

{{STRUCTURE_PLACEHOLDER}}

## Debug Process

**Given:**
- Original prompt causing false positives
- Bad example (false positive case)
- Good example (correct negative case)
- Good example (correct positive case, if available)
- **Evaluation model** that will execute the improved prompt

**Your systematic debugging approach:**

### 0. Intent Preservation (FIRST PRIORITY)
**Before making any changes, identify and preserve:**
- What is the original core purpose of this prompt?
- What domain or task is it designed for?
- What fundamental goal should remain unchanged?

### 0.5. Model-Aware Optimization
**Consider the specific evaluation model characteristics:**
- **Model type and capabilities**: Is it a reasoning model (o3-mini), instruction-following model \
(GPT-4), or domain-specific model?
- **Model strengths**: What types of tasks does this model excel at?
- **Model weaknesses**: What are known limitations or common failure modes?
- **Prompt format preferences**: Does this model respond better to specific prompt structures or \
instruction styles?
- **Context handling**: How well does this model handle long contexts, examples, or complex \
instructions?

### 1. Root Cause Analysis
Compare the bad vs good examples and identify:
- **What trigger patterns** caused the false positive?
- **What distinguishing features** does the good example have?
- **What context or constraints** are missing from the original prompt?

### 2. Failure Mode Classification
Determine the primary failure type:
- **Over-broad matching**: Prompt catches too many cases
- **Missing context**: Ignoring important situational factors
- **Weak boundaries**: Unclear decision criteria
- **Schema violations**: Not following output format requirements
- **Confidence miscalibration**: Too certain about wrong answers

### 3. Targeted Fix Design
Based on the failure mode, apply the most effective fix:
- **Add explicit exclusions** for over-broad matching
- **Require additional context** for missing context issues
- **Tighten decision criteria** for weak boundaries
- **Enforce schema compliance** for format issues
- **Add uncertainty expressions** for overconfidence
- **Model-specific optimization** - Consider the specific evaluation model's capabilities, \
training, and typical behavior patterns

### 4. Preservation Check
**MANDATORY CHECKS:**
- Ensure your fix preserves the correct behavior from all good examples (both negative and positive)
- Verify the original core intention and purpose of the prompt remains unchanged
- Confirm the domain and fundamental goal are identical to the original
- Check that true positive behavior is maintained while reducing false positives

Make your fix as minimal and targeted as possible while maximizing false positive reduction \
WITHOUT altering the prompt's original purpose.
`

const TIPS = {
  creative: "Don't be afraid to be creative when creating the new instruction!",
  simple: 'Keep the instruction clear and concise.',
  description: 'Make sure your instruction is very informative and descriptive.',
  specific: 'The instruction should include specific details such as numbers or conditions.',
  specificity: "Be more specific in your instructions. Instead of 'handle errors', " +
    'specify exactly what types of errors and how to handle them.',
  examples: 'Add concrete examples to illustrate the expected format and behavior.',
  structure: 'Use clear structure with numbered steps or bullet points to organize complex instructions.',
  constraints: 'Add explicit constraints and validation rules to prevent common mistakes.',
  context: 'Provide more context about the domain and use case to help the model understand the task better.',
  edge_cases: 'Address edge cases and corner scenarios that might cause failures.',
  formatting: 'Be explicit about output formatting requirements, including JSON structure and data types.',
  clarity: 'Use simpler, clearer language to reduce ambiguity in instructions.',
  validation: 'Include validation steps or self-checking mechanisms in the prompt.',
  priorities: 'Clearly state what aspects are most important when there are trade-offs.',
}

module.exports = { OPTIMIZATION_SYSTEM_PROMPT_TEMPLATE, TIPS }
