// Minimal structured logger. Emits one JSON object per line so logs are
// greppable and machine-parseable (ship to Loki/CloudWatch as-is), while the
// `event` field stays human-scannable in a plain terminal.

type Level = 'info' | 'warn' | 'error'

export type LogFields = Record<string, unknown>

function emit(level: Level, event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const log = {
  info: (event: string, fields?: LogFields) => emit('info', event, fields),
  warn: (event: string, fields?: LogFields) => emit('warn', event, fields),
  error: (event: string, fields?: LogFields) => emit('error', event, fields),
}

// Normalise unknown thrown values to a string message for `last_error` columns
// and log fields.
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
