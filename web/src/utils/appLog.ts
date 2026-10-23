/**
 * Frontend logger.
 *
 * Every log line in the app goes through this wrapper rather than `console.*`
 * so that the tag/level convention stays uniform and a future "send logs to the
 * host" path has one place to hook. The host bridge is intentionally absent in
 * the browser build; `setLogSink` is the seam for the Android shell.
 */

export type LogLevel = 'd' | 'i' | 'w' | 'e'

export interface LogRecord {
  level: LogLevel
  tag: string
  message: string
  args: unknown[]
  at: number
}

type Sink = (rec: LogRecord) => void

let sink: Sink | null = null
/** Ring of recent records, so a crash report can include what led up to it. */
const recent: LogRecord[] = []
const RECENT_LIMIT = 200

/** Install a host sink (Android/Electron bridge). Null restores console-only. */
export function setLogSink(fn: Sink | null) {
  sink = fn
}

/** The most recent records, oldest first. */
export function recentLogs(): LogRecord[] {
  return recent.slice()
}

function emit(level: LogLevel, tag: string, message: string, args: unknown[]) {
  const rec: LogRecord = { level, tag, message, args, at: Date.now() }
  recent.push(rec)
  if (recent.length > RECENT_LIMIT) recent.shift()

  const line = `[${tag}] ${message}`
  switch (level) {
    case 'e':
      console.error(line, ...args)
      break
    case 'w':
      console.warn(line, ...args)
      break
    case 'i':
      console.info(line, ...args)
      break
    default:
      console.debug(line, ...args)
  }
  if (sink) {
    try {
      sink(rec)
    } catch {
      // A broken sink must never take down the caller's code path.
    }
  }
}

export const appLog = {
  d: (tag: string, message: string, ...args: unknown[]) => emit('d', tag, message, args),
  i: (tag: string, message: string, ...args: unknown[]) => emit('i', tag, message, args),
  w: (tag: string, message: string, ...args: unknown[]) => emit('w', tag, message, args),
  e: (tag: string, message: string, ...args: unknown[]) => emit('e', tag, message, args),
}
