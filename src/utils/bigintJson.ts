export function bigintToStringDeep(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(bigintToStringDeep)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, bigintToStringDeep(child)]),
    )
  }
  return value
}
