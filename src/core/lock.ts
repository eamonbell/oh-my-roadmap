import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { roadmapsDir, storeLockPath } from "./paths";

const WAIT_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 60_000;
const POLL_MS = 50;

interface LockMetadata {
  pid: number;
  created_at: string;
}

const lockContext = new AsyncLocalStorage<Set<string>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH";
  }
}

async function readLockMetadata(filePath: string): Promise<LockMetadata | undefined> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(text) as Partial<LockMetadata>;
    if (typeof parsed.pid !== "number" || typeof parsed.created_at !== "string") return undefined;
    return { pid: parsed.pid, created_at: parsed.created_at };
  } catch {
    return undefined;
  }
}

async function removeStaleLock(filePath: string): Promise<boolean> {
  const metadata = await readLockMetadata(filePath);
  if (!metadata) return false;

  const createdAt = Date.parse(metadata.created_at);
  if (!Number.isFinite(createdAt) || Date.now() - createdAt <= STALE_LOCK_MS) return false;
  if (!processIsGone(metadata.pid)) return false;

  await fs.rm(filePath, { force: true });
  return true;
}

async function acquire(filePath: string): Promise<fs.FileHandle> {
  const startedAt = Date.now();
  const metadata = JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() });

  while (true) {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const handle = await fs.open(filePath, "wx");
      try {
        await handle.writeFile(metadata, "utf8");
      } catch (error) {
        await handle.close().catch(() => undefined);
        await fs.rm(filePath, { force: true }).catch(() => undefined);
        throw error;
      }
      return handle;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await removeStaleLock(filePath);
      if (Date.now() - startedAt >= WAIT_TIMEOUT_MS) {
        throw new Error("Roadmap store is busy; retry the mutating operation shortly.");
      }
      await sleep(POLL_MS);
    }
  }
}

export async function withStoreWriteLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const root = roadmapsDir(cwd);
  const activeLocks = lockContext.getStore();
  if (activeLocks?.has(root)) return await fn();

  const handle = await acquire(storeLockPath(cwd));
  const nextLocks = new Set(activeLocks ?? []);
  nextLocks.add(root);
  try {
    return await lockContext.run(nextLocks, fn);
  } finally {
    await handle.close().catch(() => undefined);
    await fs.rm(storeLockPath(cwd), { force: true }).catch(() => undefined);
  }
}
