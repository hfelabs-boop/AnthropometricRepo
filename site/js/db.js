// Loads the SQLite database (db/anthro.sqlite.gz) into sql.js once, and exposes a query helper.

const SQLJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/";
let dbPromise = null;
let rawBytes = null;

async function fetchBytes() {
  const res = await fetch("db/anthro.sqlite.gz");
  if (!res.ok) throw new Error(`Could not download the database (HTTP ${res.status}).`);
  const buf = new Uint8Array(await res.arrayBuffer());
  // Some servers transparently decode .gz; only decompress if the gzip magic bytes are present.
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return buf;
}

export function loadDB() {
  if (!dbPromise) {
    dbPromise = (async () => {
      if (typeof initSqlJs !== "function") throw new Error("sql.js failed to load from the CDN. Check your connection or ad blocker.");
      const [SQL, bytes] = await Promise.all([initSqlJs({ locateFile: f => SQLJS_CDN + f }), fetchBytes()]);
      rawBytes = bytes;
      return new SQL.Database(bytes);
    })();
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

/** Run one statement; returns { columns, rows } (rows are arrays). */
export async function query(sql, params = []) {
  const db = await loadDB();
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const columns = stmt.getColumnNames();
    const rows = [];
    while (stmt.step()) rows.push(stmt.get());
    return { columns, rows };
  } finally {
    stmt.free();
  }
}

/** Run possibly several statements (SQL console); returns the last result set. */
export async function exec(sql) {
  const db = await loadDB();
  const results = db.exec(sql);
  const last = results[results.length - 1];
  return last ? { columns: last.columns, rows: last.values } : { columns: [], rows: [], changes: db.getRowsModified() };
}

export async function objects(sql, params) {
  const { columns, rows } = await query(sql, params);
  return rows.map(r => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
}

/** The original database bytes, for the "download database" button. */
export async function databaseBytes() {
  await loadDB();
  return rawBytes;
}

/** Quote an identifier for SQLite. */
export const ident = s => `"${String(s).replace(/"/g, '""')}"`;
