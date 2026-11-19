/**
 * Database connection factory.
 *
 * `openDatabase(':memory:')` is used by the unit tests; the server passes a
 * file path (see US-018 for the Docker volume). Pragmas are applied on every
 * connection so the runtime behaves the same in tests and in production.
 */

import Database from 'better-sqlite3';

/** The concrete better-sqlite3 handle, re-exported so callers need one import. */
export type AgentMeshDatabase = Database.Database;

export interface OpenDatabaseOptions {
  /** Open read-only (useful for diagnostics / migrations dry runs). */
  readonly?: boolean;
  /** Throw instead of creating when the file is missing. */
  fileMustExist?: boolean;
  /**
   * Enable WAL on file-backed databases (default true). WAL is skipped for
   * `:memory:` because SQLite only supports `memory`/`delete` there.
   */
  wal?: boolean;
}

/**
 * Open (and configure) a SQLite database.
 *
 * - `foreign_keys = ON` keeps referential integrity once FKs are added.
 * - `busy_timeout = 5000` avoids `SQLITE_BUSY` when a second connection
 *   (e.g. a CLI or migration entrypoint) briefly holds the write lock.
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): AgentMeshDatabase {
  const db = new Database(path, {
    readonly: options.readonly ?? false,
    fileMustExist: options.fileMustExist ?? false,
  });

  db.pragma('busy_timeout = 5000');
  if (!options.readonly) {
    db.pragma('foreign_keys = ON');
    if (path !== ':memory:' && (options.wal ?? true)) {
      db.pragma('journal_mode = WAL');
    }
    // NORMAL is durable enough for WAL and much faster than FULL.
    db.pragma('synchronous = NORMAL');
  }

  return db;
}

/**
 * Per-database transaction frames for after-commit callbacks.
 *
 * better-sqlite3 has no commit hook, so `withTransaction` keeps a stack of
 * frames and `afterCommit` registers callbacks on the innermost one. A frame
 * merges into its parent only when the inner transaction commits; a rollback
 * discards the frame, so listeners never observe an event the database did not
 * commit. This matters because SQLite also rolls back `sqlite_sequence`: the
 * rolled-back `seq` is handed out again, and a client that saw a phantom event
 * would dedupe the real one away.
 */
interface TransactionFrame {
  pending: Array<() => void>;
}

const transactionFrames = new WeakMap<AgentMeshDatabase, TransactionFrame[]>();

function frameStack(db: AgentMeshDatabase): TransactionFrame[] {
  const existing = transactionFrames.get(db);
  if (existing !== undefined) return existing;
  const created: TransactionFrame[] = [];
  transactionFrames.set(db, created);
  return created;
}

function flushFrame(frame: TransactionFrame): void {
  const callbacks = frame.pending.splice(0);
  for (const callback of callbacks) {
    try {
      callback();
    } catch {
      // A subscriber bug must never undo a committed transaction.
    }
  }
}

/**
 * Run `callback` now when no tracked transaction is open, or queue it until
 * the outermost `withTransaction` commits. A callback registered inside a
 * nested transaction is merged upward only on that transaction's success.
 */
export function afterCommit(db: AgentMeshDatabase, callback: () => void): void {
  const stack = transactionFrames.get(db);
  const frame = stack?.[stack.length - 1];
  if (frame !== undefined) {
    frame.pending.push(callback);
    return;
  }
  if (db.inTransaction) {
    // A raw `db.transaction(...)` has no commit hook we can observe. Emitting
    // here would re-introduce the phantom-push bug; fail loudly instead.
    throw new Error(
      'afterCommit: transaction was not opened through withTransaction()',
    );
  }
  callback();
}

/**
 * Run `fn` inside a single SQLite transaction, rolling back on throw.
 *
 * `IMMEDIATE` takes the write lock before `fn` runs, so reads used to compute
 * an event's aggregate version / `prevHash` cannot interleave with another
 * writer. Nested calls use savepoints and merge their post-commit callbacks
 * into the parent frame only when the inner transaction commits.
 */
export function withTransaction<T>(db: AgentMeshDatabase, fn: () => T): T {
  const stack = frameStack(db);
  const frame: TransactionFrame = { pending: [] };
  stack.push(frame);
  try {
    const result = db.transaction(fn).immediate();
    stack.pop();
    const parent = stack[stack.length - 1];
    if (parent !== undefined) {
      parent.pending.push(...frame.pending);
    } else {
      flushFrame(frame);
      transactionFrames.delete(db);
    }
    return result;
  } catch (err) {
    stack.pop();
    if (stack.length === 0) {
      transactionFrames.delete(db);
    }
    throw err;
  }
}
