import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type DiagnosticLevel = "debug" | "info" | "warn" | "error";
type ConfiguredLevel = DiagnosticLevel | "off";

interface FallbackLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

interface DiagnosticLoggerConfig {
  fallbackLogger?: FallbackLogger;
  homeDir?: string;
}

export interface DiagnosticLogOptions {
  level: DiagnosticLevel;
  component: string;
  operation: string;
  cwd?: string;
  durationMs?: number;
  success?: boolean;
  metadata?: Record<string, unknown>;
  error?: unknown;
}

export interface DiagnosticTimingOptions {
  component: string;
  operation: string;
  cwd?: string;
  metadata?: Record<string, unknown>;
  slowMs?: number;
}

const LEVELS: Record<ConfiguredLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  off: Number.POSITIVE_INFINITY,
};

let fallbackLogger: FallbackLogger | undefined;
let configuredHomeDir: string | undefined;

export function configureDiagnosticLogger(config: DiagnosticLoggerConfig): void {
  fallbackLogger = config.fallbackLogger;
  configuredHomeDir = config.homeDir;
}

function activeLevel(): ConfiguredLevel {
  const raw = process.env.ROADMAP_ENGINEER_LOG_LEVEL?.trim().toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error" || raw === "off") return raw;
  return "info";
}

function shouldLog(level: DiagnosticLevel): boolean {
  return LEVELS[level] >= LEVELS[activeLevel()];
}

function logDir(): string {
  return path.join(configuredHomeDir ?? process.env.HOME ?? os.homedir(), ".roadmap-engineer", "logs");
}

function logPath(at: string): string {
  return path.join(logDir(), `${at.slice(0, 10)}.ndjson`);
}

function errorMetadata(error: unknown, includeStack: boolean): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(includeStack && error.stack ? { stack: error.stack } : {}),
    };
  }
  return { message: String(error) };
}

function safeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (
      value === undefined ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      safe[key] = value;
    }
  }
  return safe;
}

async function writeEntry(entry: Record<string, unknown>): Promise<void> {
  const at = typeof entry.at === "string" ? entry.at : new Date().toISOString();
  await fs.mkdir(logDir(), { recursive: true });
  await fs.appendFile(logPath(at), `${JSON.stringify(entry)}\n`, "utf8");
}

export async function logDiagnostic(options: DiagnosticLogOptions): Promise<void> {
  if (!shouldLog(options.level)) return;
  const at = new Date().toISOString();
  const level = activeLevel();
  const entry: Record<string, unknown> = {
    schema_version: 1,
    at,
    level: options.level,
    component: options.component,
    operation: options.operation,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.durationMs !== undefined ? { duration_ms: options.durationMs } : {}),
    ...(options.success !== undefined ? { success: options.success } : {}),
    ...(safeMetadata(options.metadata) ? { metadata: safeMetadata(options.metadata) } : {}),
    ...(options.error ? { error: errorMetadata(options.error, level === "debug") } : {}),
  };
  try {
    await writeEntry(entry);
  } catch (error) {
    fallbackLogger?.warn("roadmap-engineer diagnostic logging failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function withDiagnosticTiming<T>(
  options: DiagnosticTimingOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  await logDiagnostic({
    level: "debug",
    component: options.component,
    operation: `${options.operation}.start`,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
  try {
    const result = await fn();
    const durationMs = Date.now() - startedAt;
    await logDiagnostic({
      level: options.slowMs !== undefined && durationMs > options.slowMs ? "warn" : "info",
      component: options.component,
      operation: options.operation,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      durationMs,
      success: true,
      ...(options.metadata ? { metadata: options.metadata } : {}),
    });
    return result;
  } catch (error) {
    await logDiagnostic({
      level: "error",
      component: options.component,
      operation: options.operation,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      durationMs: Date.now() - startedAt,
      success: false,
      ...(options.metadata ? { metadata: options.metadata } : {}),
      error,
    });
    throw error;
  }
}
