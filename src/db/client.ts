import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import {
  databasePath,
  openSqliteDatabase,
  type SqliteDatabase,
} from "./sqlite.js";

export type AppDatabase = ReturnType<typeof createDrizzleDatabase>;
export { databasePath };

export interface DatabaseHandle {
  sqlite: SqliteDatabase;
  db: AppDatabase;
  close(): void;
}

export function openDatabase(stateDir: string): DatabaseHandle {
  const handle = openSqliteDatabase(stateDir);

  return {
    sqlite: handle.sqlite,
    db: createDrizzleDatabase(handle.sqlite),
    close: handle.close,
  };
}

function createDrizzleDatabase(sqlite: SqliteDatabase) {
  return drizzle(sqlite, { schema });
}
