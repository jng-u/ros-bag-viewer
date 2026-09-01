import sqlite3InitModule, { type Database, type SqlValue, type Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import type {
  SqliteEntryContext,
  SqliteQueryProvider,
  SqliteReadonlyDatabase,
  SqliteRow,
  SqliteValue,
} from "@ros-web-viewer/source-ros2-sqlite";

const MAX_MATERIALIZED_DATABASE_BYTES = 512 * 1024 * 1024;
const MATERIALIZE_CHUNK_BYTES = 8 * 1024 * 1024;

let sqlitePromise: Promise<Sqlite3Static> | undefined;

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
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async query(sql: string, parameters: readonly SqliteValue[], signal: AbortSignal): Promise<readonly SqliteRow[]> {
    if (signal.aborted) throw new DOMException("SQLite query aborted", "AbortError");
    const rows = this.#database.exec({
      sql,
      bind: parameters,
      rowMode: "object",
      returnValue: "resultRows",
    });
    if (signal.aborted) throw new DOMException("SQLite query aborted", "AbortError");
    return rows.map((row) => Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, normalizedValue(value)]),
    ));
  }

  async close(): Promise<void> {
    this.#database.close();
  }
}

/** Materializes one bounded db3 part into SQLite WASM and opens it read-only. */
export class BrowserSqliteQueryProvider implements SqliteQueryProvider {
  async open(entry: SqliteEntryContext, signal: AbortSignal): Promise<SqliteReadonlyDatabase> {
    if (entry.sizeBytes > BigInt(MAX_MATERIALIZED_DATABASE_BYTES)) {
      throw new Error(`SQLite part ${entry.relativePath} exceeds the 512 MB browser materialization limit.`);
    }
    const bytes = new Uint8Array(Number(entry.sizeBytes));
    for (let offset = 0; offset < bytes.byteLength; offset += MATERIALIZE_CHUNK_BYTES) {
      if (signal.aborted) throw new DOMException("SQLite open aborted", "AbortError");
      const length = Math.min(MATERIALIZE_CHUNK_BYTES, bytes.byteLength - offset);
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
}
