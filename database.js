/**
 * Database module — PostgreSQL (Railway) / SQLite (local dev)
 *
 * Tables:
 *   shopify_sessions  — Shopify OAuth sessions
 *   app_settings      — Per-shop label profile settings
 *   print_history     — Log of generated label PDFs
 */

import pg from 'pg';
import { SQLiteSessionStorage } from '@shopify/shopify-app-session-storage-sqlite';
import { Session } from '@shopify/shopify-api';
import Database from 'better-sqlite3';

let pgPool = null;
let sqliteDb = null;
export let sessionStorage = null;

export async function initDatabase() {
  const dbUrl = process.env.DATABASE_URL || '';

  if (dbUrl.startsWith('postgres')) {
    pgPool = new pg.Pool({
      connectionString: dbUrl,
      ssl: dbUrl.includes('railway') ? { rejectUnauthorized: false } : false,
    });
    await setupPostgresTables();
    sessionStorage = createPostgresSessionStorage();
    console.log('✅ PostgreSQL database ready');
  } else {
    sqliteDb = new Database('sessions.db');
    setupSQLiteTables();
    sessionStorage = new SQLiteSessionStorage('sessions.db');
    console.log('✅ SQLite database ready (local dev)');
  }
}

// ─── Table Setup ────────────────────────────────────────────────────────

async function setupPostgresTables() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS shopify_sessions (
      id TEXT PRIMARY KEY,
      shop TEXT NOT NULL,
      state TEXT,
      is_online BOOLEAN DEFAULT FALSE,
      scope TEXT,
      expires INTEGER,
      access_token TEXT,
      online_access_info TEXT
    )
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      shop TEXT PRIMARY KEY,
      settings_json TEXT NOT NULL DEFAULT '{}',
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS print_history (
      id SERIAL PRIMARY KEY,
      shop TEXT NOT NULL,
      label_count INTEGER NOT NULL,
      offset_used INTEGER DEFAULT 0,
      profile_name TEXT,
      mode TEXT DEFAULT 'barcode',
      products_json TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

function setupSQLiteTables() {
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      shop TEXT PRIMARY KEY,
      settings_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS print_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop TEXT NOT NULL,
      label_count INTEGER NOT NULL,
      offset_used INTEGER DEFAULT 0,
      profile_name TEXT,
      mode TEXT DEFAULT 'barcode',
      products_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

// ─── PostgreSQL Session Storage ──────────────────────────────────────────────

function createPostgresSessionStorage() {
  return {
    async storeSession(session) {
      await pgPool.query(
        `INSERT INTO shopify_sessions (id, shop, state, is_online, scope, expires, access_token)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           shop = EXCLUDED.shop, state = EXCLUDED.state, is_online = EXCLUDED.is_online,
           scope = EXCLUDED.scope, expires = EXCLUDED.expires, access_token = EXCLUDED.access_token`,
        [session.id, session.shop, session.state, session.isOnline, session.scope, session.expires, session.accessToken]
      );
      return true;
    },
    async loadSession(id) {
      const result = await pgPool.query('SELECT * FROM shopify_sessions WHERE id = $1', [id]);
      if (!result.rows.length) return undefined;
      const r = result.rows[0];
      return new Session({
        id: r.id, shop: r.shop, state: r.state, isOnline: r.is_online,
        scope: r.scope, expires: r.expires ? new Date(r.expires) : undefined,
        accessToken: r.access_token,
      });
    },
    async deleteSession(id) {
      await pgPool.query('DELETE FROM shopify_sessions WHERE id = $1', [id]);
      return true;
    },
    async deleteSessions(ids) {
      await pgPool.query('DELETE FROM shopify_sessions WHERE id = ANY($1)', [ids]);
      return true;
    },
    async findSessionsByShop(shop) {
      const result = await pgPool.query('SELECT * FROM shopify_sessions WHERE shop = $1', [shop]);
      return result.rows.map(r => new Session({
        id: r.id, shop: r.shop, state: r.state, isOnline: r.is_online,
        scope: r.scope, expires: r.expires ? new Date(r.expires) : undefined,
        accessToken: r.access_token,
      }));
    },
  };
}

// ─── Settings ────────────────────────────────────────────────────────────

export function getDefaultSettings() {
  return {
    // Default label profile: Avery 6460 (the tuned barcode profile)
    active_profile: 'avery_6460',
    profiles: {
      avery_6460: {
        name: 'Avery 6460 (Mini Address Labels)',
        description: 'Custom tuned - perfectly aligned',
        label_width: 2.975,
        label_height: 1.075,
        labels_per_row: 3,
        labels_per_col: 10,
        page_margin_left: -0.2295,
        page_margin_top: 0.335,
        label_margin: 0.0,
      },
      avery_5160: {
        name: 'Avery 5160 (Address Labels)',
        description: '2.625" x 1.0", 3 across, 10 down',
        label_width: 2.625,
        label_height: 1.0,
        labels_per_row: 3,
        labels_per_col: 10,
        page_margin_left: 0.1875,
        page_margin_top: 0.5,
        label_margin: 0.0,
      },
      avery_5261: {
        name: 'Avery 5261 (Address Labels)',
        description: '4.0" x 1.0", 2 across, 10 down',
        label_width: 4.0,
        label_height: 1.0,
        labels_per_row: 2,
        labels_per_col: 10,
        page_margin_left: 0.15625,
        page_margin_top: 0.5,
        label_margin: 0.0,
      },
      avery_5162: {
        name: 'Avery 5162 (Address Labels)',
        description: '4.0" x 1.33", 2 across, 7 down',
        label_width: 4.0,
        label_height: 1.33,
        labels_per_row: 2,
        labels_per_col: 7,
        page_margin_left: 0.15625,
        page_margin_top: 0.83,
        label_margin: 0.0,
      },
    },
    // Default mode
    default_mode: 'barcode',
    // Default offset
    default_offset: 0,
    // Font/barcode scaling
    font_scale: 0.85,
    barcode_scale: 0.9,
  };
}

export async function getSettings(shop) {
  if (pgPool) {
    const result = await pgPool.query('SELECT settings_json FROM app_settings WHERE shop = $1', [shop]);
    return result.rows.length
      ? { ...getDefaultSettings(), ...JSON.parse(result.rows[0].settings_json) }
      : getDefaultSettings();
  } else {
    const row = sqliteDb.prepare('SELECT settings_json FROM app_settings WHERE shop = ?').get(shop);
    return row ? { ...getDefaultSettings(), ...JSON.parse(row.settings_json) } : getDefaultSettings();
  }
}

export async function saveSettings(shop, settings) {
  const json = JSON.stringify(settings);
  if (pgPool) {
    await pgPool.query(
      `INSERT INTO app_settings (shop, settings_json, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (shop) DO UPDATE SET settings_json = $2, updated_at = NOW()`,
      [shop, json]
    );
  } else {
    sqliteDb.prepare('INSERT OR REPLACE INTO app_settings (shop, settings_json) VALUES (?, ?)').run(shop, json);
  }
}

// ─── Print History ───────────────────────────────────────────────────────────

export async function savePrintHistory(shop, data) {
  const { label_count, offset_used, profile_name, mode, products_json } = data;
  if (pgPool) {
    const result = await pgPool.query(
      `INSERT INTO print_history (shop, label_count, offset_used, profile_name, mode, products_json)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [shop, label_count, offset_used || 0, profile_name, mode, products_json]
    );
    return result.rows[0].id;
  } else {
    const stmt = sqliteDb.prepare(
      `INSERT INTO print_history (shop, label_count, offset_used, profile_name, mode, products_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const info = stmt.run(shop, label_count, offset_used || 0, profile_name, mode, products_json);
    return info.lastInsertRowid;
  }
}

export async function getPrintHistory(shop, limit = 50) {
  if (pgPool) {
    const result = await pgPool.query(
      'SELECT * FROM print_history WHERE shop = $1 ORDER BY created_at DESC LIMIT $2',
      [shop, limit]
    );
    return result.rows;
  } else {
    return sqliteDb.prepare(
      'SELECT * FROM print_history WHERE shop = ? ORDER BY created_at DESC LIMIT ?'
    ).all(shop, limit);
  }
}
