'use strict'

// Remote Config product names used by ASM/WAF.
const ASM_WAF_PRODUCTS = ['ASM', 'ASM_DD', 'ASM_DATA']
const ASM_WAF_PRODUCTS_SET = new Set(ASM_WAF_PRODUCTS)

module.exports = {
  ASM_WAF_PRODUCTS,
  ASM_WAF_PRODUCTS_SET,
}
