import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import * as fs from "fs";

const DB_PATH = path.resolve(process.cwd(), "storage", "cineclip.db");

// Ensure storage directory exists before opening database
const storageDir = path.dirname(DB_PATH);
if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir, { recursive: true });
}

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite, { schema });

export function runMigrations() {
  const migrationsFolder = path.resolve(process.cwd(), "server", "drizzle");
  migrate(db, { migrationsFolder });
}

export * from "./schema";
