import sqlite3InitModule, { type Database, type SqlValue, type Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import type {
  SqliteEntryContext,
  SqliteQueryProvider,
  SqliteReadonlyDatabase,
  SqliteRow,
  SqliteValue,
} from "@ros-web-viewer/source-ros2-sqlite";

const IMPORT_CHUNK_BYTES = 8 * 1024 * 1024;
const TEST_ONLY_MATERIALIZED_LIMIT_BYTES = 64 * 1024 * 1024;
export const MAX_BROWSER_SQLITE_PARTS = 16;

let sqlitePromise: Promise<Sqlite3Static> | undefined;
type OpfsPool = Awaited<ReturnType<Sqlite3Static["installOpfsSAHPoolVfs"]>>;
let opfsPoolPromise: Promise<OpfsPool> | undefined;
let opfsPoolRemoval: Promise<void> = Promise.resolve();
let activeOpfsDatabases = 0;

function randomHex(bytes = 16): string {
  const value = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(value);
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

let opfsPoolId = randomHex();

export function configureBrowserSqliteNamespace(namespace: string): void {
  if (!/^[a-f0-9]{32}$/u.test(namespace)) throw new Error("SQLite OPFS namespace must be a 128-bit lowercase hexadecimal id.");
  if (opfsPoolPromise || activeOpfsDatabases !== 0) throw new Error("SQLite OPFS namespace cannot change after the pool is initialized.");
  opfsPoolId = namespace;
}

function sqlite(): Promise<Sqlite3Static> {
  sqlitePromise ??= sqlite3InitModule();
  return sqlitePromise;
}

function normalizedValue(value: SqlValue): SqliteValue {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof Int8Array) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return value;
}

class WasmReadonlyDatabase implements SqliteReadonlyDatabase {
  #closed = false;
  readonly #database: Database;
  readonly #cleanup: () => void | Promise<void>;

  constructor(
    database: Database,
    cleanup: () => void | Promise<void> = () => undefined,
  ) {
    this.#database = database;
    this.#cleanup = cleanup;
  }

  async query(sql: string, parameters: readonly SqliteValue[], signal: AbortSignal): Promise<readonly SqliteRow[]> {
    if (signal.aborted) throw new DOMException("SQLite query aborted", "AbortError");
    if (this.#closed) throw new Error("SQLite database is closed.");
    const rows = this.#database.exec({ sql, bind: parameters, rowMode: "object", returnValue: "resultRows" });
    if (signal.aborted) throw new DOMException("SQLite query aborted", "AbortError");
    return rows.map((row) => Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, normalizedValue(value)]),
    ));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#database.close(); } finally { await this.#cleanup(); }
  }
}

function supportsWorkerOpfs(): boolean {
  return typeof document === "undefined"
    && typeof navigator !== "undefined"
    && typeof navigator.storage?.getDirectory === "function";
}

async function opfsPool(sqlite3: Sqlite3Static): Promise<OpfsPool> {
  await opfsPoolRemoval;
  opfsPoolPromise ??= sqlite3.installOpfsSAHPoolVfs({
    clearOnInit: true,
    directory: `.ros-web-viewer-sqlite-${opfsPoolId}`,
    initialCapacity: 6,
    name: `ros-web-viewer-sqlite-${opfsPoolId}`,
  });
  return opfsPoolPromise;
}

async function releaseOpfsPool(pool: OpfsPool): Promise<void> {
  activeOpfsDatabases -= 1;
  if (activeOpfsDatabases !== 0 || !opfsPoolPromise) return;
  const current = opfsPoolPromise;
  opfsPoolPromise = undefined;
  opfsPoolRemoval = current.then(async (installed) => { if (installed === pool) await installed.removeVfs(); }).then(() => undefined);
  await opfsPoolRemoval;
}

async function openOutOfCore(entry: SqliteEntryContext, signal: AbortSignal): Promise<SqliteReadonlyDatabase> {
  if (entry.sizeBytes <= 0n || entry.sizeBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`SQLite part ${entry.relativePath} has an unsupported size.`);
  }
  const sqlite3 = await sqlite();
  const pool = await opfsPool(sqlite3);
  await pool.reserveMinimumCapacity(Math.min(MAX_BROWSER_SQLITE_PARTS * 2 + 1, (activeOpfsDatabases + 1) * 2 + 1));
  activeOpfsDatabases += 1;
  const filename = `/recording-${randomHex()}.db3`;
  let offset = 0n;
  try {
    const importedBytes = await pool.importDb(filename, async () => {
      if (signal.aborted) throw new DOMException("SQLite open aborted", "AbortError");
      if (offset === entry.sizeBytes) return undefined;
      const remaining = entry.sizeBytes - offset;
      const length = remaining > BigInt(IMPORT_CHUNK_BYTES) ? BigInt(IMPORT_CHUNK_BYTES) : remaining;
      const chunk = await entry.read(offset, length, signal);
      if (BigInt(chunk.byteLength) !== length) throw new Error(`SQLite part ${entry.relativePath} was truncated.`);
      offset += length;
      return chunk;
    });
    if (BigInt(importedBytes) !== entry.sizeBytes) throw new Error(`SQLite part ${entry.relativePath} was not imported completely.`);
    if (signal.aborted) throw new DOMException("SQLite open aborted", "AbortError");
    const database = new sqlite3.oo1.DB({ filename, flags: "r", vfs: pool.vfsName });
    return new WasmReadonlyDatabase(database, async () => {
      try { pool.unlink(filename); } finally { await releaseOpfsPool(pool); }
    });
  } catch (error) {
    try { pool.unlink(filename); } finally { await releaseOpfsPool(pool); }
    throw error;
  }
}

async function openMaterializedTestDatabase(entry: SqliteEntryContext, signal: AbortSignal): Promise<SqliteReadonlyDatabase> {
  if (entry.sizeBytes > BigInt(TEST_ONLY_MATERIALIZED_LIMIT_BYTES)) {
    throw new Error(`SQLite test fixture ${entry.relativePath} exceeds the 64 MB test-only materialization limit.`);
  }
  const bytes = new Uint8Array(Number(entry.sizeBytes));
  for (let offset = 0; offset < bytes.byteLength; offset += IMPORT_CHUNK_BYTES) {
    if (signal.aborted) throw new DOMException("SQLite open aborted", "AbortError");
    const length = Math.min(IMPORT_CHUNK_BYTES, bytes.byteLength - offset);
    const chunk = await entry.read(BigInt(offset), BigInt(length), signal);
    if (chunk.byteLength !== length) throw new Error(`SQLite part ${entry.relativePath} was truncated.`);
    bytes.set(chunk, offset);
  }

  const sqlite3 = await sqlite();
  if (signal.aborted) throw new DOMException("SQLite open aborted", "AbortError");
  const database = new sqlite3.oo1.DB();
  const allocation = sqlite3.wasm.allocFromTypedArray(bytes);
  database.onclose = { after: () => sqlite3.wasm.dealloc(allocation) };
  try {
    const pointer = database.pointer;
    if (pointer === undefined) throw new Error("SQLite WASM did not open an in-memory database handle.");
    database.checkRc(sqlite3.capi.sqlite3_deserialize(
      pointer,
      "main",
      allocation,
      bytes.byteLength,
      bytes.byteLength,
      sqlite3.capi.SQLITE_DESERIALIZE_READONLY,
    ));
    return new WasmReadonlyDatabase(database);
  } catch (error) {
    database.close();
    throw error;
  }
}

/**
 * Opens product ROS2 db3 parts through a worker-local OPFS VFS. Import is pulled
 * in bounded chunks, and SQLite pages are read from OPFS instead of a second
 * whole-database Uint8Array/WASM copy. The materialized path is test-only.
 */
export class BrowserSqliteQueryProvider implements SqliteQueryProvider {
  constructor(private readonly allowMaterializedTestFallback = false, private readonly forceInline = false) {}

  async open(entry: SqliteEntryContext, signal: AbortSignal): Promise<SqliteReadonlyDatabase> {
    if (supportsWorkerOpfs()) return openOutOfCore(entry, signal);
    if (!this.allowMaterializedTestFallback) {
      const boundary = this.forceInline ? "recording Worker with OPFS" : "recording Worker";
      throw new Error(`ROS2 SQLite requires a ${boundary}; whole-database browser materialization is disabled.`);
    }
    return openMaterializedTestDatabase(entry, signal);
  }
}
