import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { repairToolCallMessages } from './agent/session';
import { APP_DB_FILE_NAME, LEGACY_APP_DB_FILE_NAME, legacyUserDataDir, userDataDir } from './app-paths';

export interface SessionData {
  id: string;
  title?: string;
  projectPath?: string;
  modelId?: string;
  messages?: unknown[];
  agentMessages?: unknown[];
  createdAt?: number;
  updatedAt?: number;
  pinnedAt?: number | null;
  groupId?: string | null;
}

export interface SessionGroupData {
  id: string;
  name: string;
  createdAt?: number;
  updatedAt?: number;
  pinnedAt?: number | null;
  collapsed?: boolean;
}

interface SessionRow {
  id: string;
  title: string | null;
  project_path: string | null;
  model_id: string | null;
  messages_json: string | null;
  agent_messages_json: string | null;
  created_at: number | null;
  updated_at: number | null;
  pinned_at: number | null;
  group_id: string | null;
}

interface SessionGroupRow {
  id: string;
  name: string;
  created_at: number | null;
  updated_at: number | null;
  pinned_at: number | null;
  collapsed: number | null;
}

let db: Database.Database | null = null;

function dataDir(): string {
  return userDataDir();
}

function legacySessionsDir(): string {
  return join(dataDir(), 'sessions');
}

function ensureLegacyDbCopied(): void {
  const nextDb = join(dataDir(), APP_DB_FILE_NAME);
  if (existsSync(nextDb)) return;
  const legacyDb = join(legacyUserDataDir(), LEGACY_APP_DB_FILE_NAME);
  if (!existsSync(legacyDb)) return;
  mkdirSync(dataDir(), { recursive: true });
  copyFileSync(legacyDb, nextDb);
}

function parseArrayJson(value: string | null): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToSession(row: SessionRow, includeMessages: boolean): SessionData {
  const session: SessionData = {
    id: row.id,
    title: row.title || undefined,
    projectPath: row.project_path || undefined,
    modelId: row.model_id || undefined,
    createdAt: row.created_at || undefined,
    updatedAt: row.updated_at || undefined,
    pinnedAt: row.pinned_at ?? null,
    groupId: row.group_id ?? null,
  };
  if (includeMessages) {
    session.messages = parseArrayJson(row.messages_json);
    session.agentMessages = repairToolCallMessages(parseArrayJson(row.agent_messages_json) as any);
  }
  return session;
}

export function getDb(): Database.Database {
  if (db) return db;

  mkdirSync(dataDir(), { recursive: true });
  ensureLegacyDbCopied();
  db = new Database(join(dataDir(), APP_DB_FILE_NAME));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      project_path TEXT,
      model_id TEXT,
      messages_json TEXT NOT NULL DEFAULT '[]',
      agent_messages_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      pinned_at INTEGER,
      group_id TEXT
    );
    CREATE TABLE IF NOT EXISTS session_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      pinned_at INTEGER,
      collapsed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_session_groups_updated_at ON session_groups(updated_at DESC);
  `);

  const columns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  if (!columns.some(col => col.name === 'pinned_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN pinned_at INTEGER');
  }
  if (!columns.some(col => col.name === 'group_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN group_id TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_group_id ON sessions(group_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_pinned_created_at ON sessions(pinned_at DESC, created_at ASC)');

  migrateLegacyJsonSessions(db);
  return db;
}

function migrateLegacyJsonSessions(database: Database.Database): void {
  const dir = legacySessionsDir();
  if (!existsSync(dir)) return;

  const insert = database.prepare(`
    INSERT OR IGNORE INTO sessions (
      id, title, project_path, model_id, messages_json, agent_messages_json, created_at, updated_at
    ) VALUES (
      @id, @title, @projectPath, @modelId, @messagesJson, @agentMessagesJson, @createdAt, @updatedAt
    )
  `);

  const migrate = database.transaction(() => {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = readFileSync(join(dir, name), 'utf8');
        const session = JSON.parse(raw) as SessionData;
        if (!session.id) continue;
        const now = Date.now();
        insert.run({
          id: session.id,
          title: session.title ?? null,
          projectPath: session.projectPath ?? null,
          modelId: session.modelId ?? null,
          messagesJson: JSON.stringify(session.messages || []),
          agentMessagesJson: JSON.stringify(session.agentMessages || []),
          createdAt: session.createdAt || session.updatedAt || now,
          updatedAt: session.updatedAt || now,
          groupId: session.groupId ?? null,
        });
      } catch {
        // Ignore corrupt legacy session files; they should not block app startup.
      }
    }
  });

  migrate();
}

export function saveSession(session: SessionData): void {
  const database = getDb();
  const existing = loadSession(session.id);
  const now = Date.now();
  const merged: SessionData = {
    id: session.id,
    title: session.title ?? existing?.title,
    projectPath: session.projectPath ?? existing?.projectPath,
    modelId: session.modelId ?? existing?.modelId,
    messages: session.messages ?? existing?.messages ?? [],
    agentMessages: repairToolCallMessages((session.agentMessages ?? existing?.agentMessages ?? []) as any),
    createdAt: session.createdAt || existing?.createdAt || now,
    updatedAt: session.updatedAt || now,
    pinnedAt: session.pinnedAt !== undefined ? session.pinnedAt : existing?.pinnedAt ?? null,
    groupId: session.groupId !== undefined ? session.groupId : existing?.groupId ?? null,
  };

  database.prepare(`
    INSERT INTO sessions (
      id, title, project_path, model_id, messages_json, agent_messages_json, created_at, updated_at, pinned_at, group_id
    ) VALUES (
      @id, @title, @projectPath, @modelId, @messagesJson, @agentMessagesJson, @createdAt, @updatedAt, @pinnedAt, @groupId
    )
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      project_path = excluded.project_path,
      model_id = excluded.model_id,
      messages_json = excluded.messages_json,
      agent_messages_json = excluded.agent_messages_json,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      pinned_at = excluded.pinned_at,
      group_id = excluded.group_id
  `).run({
    id: merged.id,
    title: merged.title ?? null,
    projectPath: merged.projectPath ?? null,
    modelId: merged.modelId ?? null,
    messagesJson: JSON.stringify(merged.messages || []),
    agentMessagesJson: JSON.stringify(merged.agentMessages || []),
    createdAt: merged.createdAt,
    updatedAt: merged.updatedAt,
    pinnedAt: merged.pinnedAt ?? null,
    groupId: merged.groupId ?? null,
  });
}

export function loadSession(id: string): SessionData | null {
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  return row ? rowToSession(row, true) : null;
}

export function listSessions(): SessionData[] {
  const rows = getDb()
    .prepare(`
      SELECT id, title, project_path, model_id, NULL AS messages_json, NULL AS agent_messages_json, created_at, updated_at, pinned_at, group_id
      FROM sessions
      ORDER BY
        CASE WHEN pinned_at IS NULL THEN 1 ELSE 0 END,
        pinned_at DESC,
        updated_at DESC,
        id ASC
    `)
    .all() as SessionRow[];
  return rows.map(row => rowToSession(row, false));
}

export function deleteSession(id: string): void {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function renameSession(id: string, title: string): boolean {
  const result = getDb()
    .prepare('UPDATE sessions SET title = ? WHERE id = ?')
    .run(title, id);
  return result.changes > 0;
}

export function setSessionPinned(id: string, pinned: boolean): boolean {
  const result = getDb()
    .prepare('UPDATE sessions SET pinned_at = ? WHERE id = ?')
    .run(pinned ? Date.now() : null, id);
  return result.changes > 0;
}

function rowToGroup(row: SessionGroupRow): SessionGroupData {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at || undefined,
    updatedAt: row.updated_at || undefined,
    pinnedAt: row.pinned_at ?? null,
    collapsed: Boolean(row.collapsed),
  };
}

export function listSessionGroups(): SessionGroupData[] {
  const rows = getDb()
    .prepare('SELECT * FROM session_groups ORDER BY pinned_at DESC, updated_at DESC, name ASC')
    .all() as SessionGroupRow[];
  return rows.map(rowToGroup);
}

export function createSessionGroup(name = '新建组'): SessionGroupData {
  const now = Date.now();
  const group: SessionGroupData = {
    id: `group_${now}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    createdAt: now,
    updatedAt: now,
    pinnedAt: null,
    collapsed: false,
  };
  getDb().prepare(`
    INSERT INTO session_groups (id, name, created_at, updated_at, pinned_at, collapsed)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(group.id, group.name, now, now, null, 0);
  return group;
}

export function renameSessionGroup(id: string, name: string): boolean {
  const result = getDb()
    .prepare('UPDATE session_groups SET name = ? WHERE id = ?')
    .run(name, id);
  return result.changes > 0;
}

export function setSessionGroupPinned(id: string, pinned: boolean): boolean {
  const result = getDb()
    .prepare('UPDATE session_groups SET pinned_at = ? WHERE id = ?')
    .run(pinned ? Date.now() : null, id);
  return result.changes > 0;
}

export function setSessionGroupCollapsed(id: string, collapsed: boolean): boolean {
  const result = getDb()
    .prepare('UPDATE session_groups SET collapsed = ? WHERE id = ?')
    .run(collapsed ? 1 : 0, id);
  return result.changes > 0;
}

export function setSessionGroup(sessionId: string, groupId: string | null): boolean {
  const database = getDb();
  if (groupId) {
    const group = database.prepare('SELECT id FROM session_groups WHERE id = ?').get(groupId);
    if (!group) return false;
  }
  const result = database
    .prepare('UPDATE sessions SET group_id = ? WHERE id = ?')
    .run(groupId, sessionId);
  return result.changes > 0;
}

export function deleteSessionGroup(id: string): boolean {
  const database = getDb();
  const tx = database.transaction(() => {
    database.prepare('UPDATE sessions SET group_id = NULL WHERE group_id = ?').run(id);
    return database.prepare('DELETE FROM session_groups WHERE id = ?').run(id).changes > 0;
  });
  return tx();
}
