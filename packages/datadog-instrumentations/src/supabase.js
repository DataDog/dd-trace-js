'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('@supabase/supabase-js')) {
  addHook(hook, exports => exports)
}

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
