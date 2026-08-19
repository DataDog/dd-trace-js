'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

addHook({ name: '@supabase/supabase-js', versions: ['>=2.112.2 <3'] }, exports => exports)

for (const hook of getHooks('@supabase/auth-js')) {
  addHook(hook, exports => exports)
}

for (const hook of getHooks('@supabase/storage-js')) {
  addHook(hook, exports => exports)
}

for (const hook of getHooks('@supabase/realtime-js')) {
  addHook(hook, exports => exports)
}

for (const hook of getHooks('@supabase/functions-js')) {
  addHook(hook, exports => exports)
}

for (const hook of getHooks('@supabase/postgrest-js')) {
  addHook(hook, exports => exports)
}
