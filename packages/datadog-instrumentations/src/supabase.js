'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

addHook({ name: '@supabase/supabase-js', versions: ['>=2.112.2'] }, exports => exports)

for (const hook of getHooks([
  '@supabase/auth-js',
  '@supabase/storage-js',
  '@supabase/realtime-js',
  '@supabase/functions-js',
  '@supabase/postgrest-js',
]).values()) {
  addHook(hook, exports => exports)
}
