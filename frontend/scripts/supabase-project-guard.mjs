const LITTLEOS_REFS = new Set([
  'vnzoksaiowqwaukmtbsi',
  'lifmjtvfoppoxymvcemq',
  'gjeymxxhrggsxytzbiur',
])

export function requireMiniOpProjectRef() {
  const ref = (process.env.SUPABASE_PROJECT_REF ?? '').trim()
  if (!ref) {
    throw new Error('SUPABASE_PROJECT_REF is required in .env')
  }
  if (LITTLEOS_REFS.has(ref)) {
    throw new Error(
      `SUPABASE_PROJECT_REF=${ref} is a LittleOS project — use MiniOp project pycaruihndpxznvxuqdk`,
    )
  }
  return ref
}