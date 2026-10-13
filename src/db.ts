import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Status =
  | "queued"
  | "transcribing"
  | "transcribed"
  | "summarizing"
  | "done"
  | "failed";

export interface Recording {
  id: number;
  created_at: string;
  title: string;
  status: Status;
  progress: number;
  error: string | null;
  transcript: string | null; // JSON: Segment[]
  summary: string | null; // JSON: Summary
}

const dbPath = Bun.env.DB_PATH ?? "data/app.db";
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath, { create: true });
db.run("PRAGMA journal_mode = WAL");
db.run(`
  CREATE TABLE IF NOT EXISTS recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    progress INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    transcript TEXT,
    summary TEXT
  )
`);

// A crash mid-run leaves rows in an in-progress state; send them back a step.
db.run("UPDATE recordings SET status = 'queued', progress = 0 WHERE status = 'transcribing'");
db.run("UPDATE recordings SET status = 'transcribed', progress = 0 WHERE status = 'summarizing'");

export const createRecording = (title: string) =>
  db.query("INSERT INTO recordings (title) VALUES (?) RETURNING id").get(title) as { id: number };

export const listRecordings = () =>
  db
    .query("SELECT id, created_at, title, status, progress, error FROM recordings ORDER BY id DESC")
    .all();

export const getRecording = (id: number) =>
  db.query("SELECT * FROM recordings WHERE id = ?").get(id) as Recording | null;

export const deleteRecording = (id: number) => db.query("DELETE FROM recordings WHERE id = ?").run(id);

export const nextWithStatus = (status: Status) =>
  db.query("SELECT * FROM recordings WHERE status = ? ORDER BY id LIMIT 1").get(status) as Recording | null;

export const queuePosition = (id: number) =>
  (db.query("SELECT COUNT(*) AS n FROM recordings WHERE status = 'queued' AND id < ?").get(id) as { n: number }).n + 1;

export function update(id: number, fields: Partial<Omit<Recording, "id" | "created_at">>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sql = `UPDATE recordings SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`;
  db.query(sql).run(...(Object.values(fields) as (string | number | null)[]), id);
}
