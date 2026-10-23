package com.clawterm.app;

import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.content.ContentValues;
import android.database.Cursor;

/**
 * Local database.
 *
 * ## Why SQLite and not JSON files
 *
 * The host list, snippets and forward rules are edited one row at a time from
 * several screens. A single JSON file would need read-modify-write on every edit,
 * and a process death mid-write loses everything. SQLite gives atomic writes for
 * free and keeps the queries honest.
 *
 * ## Why the credential store is separate
 *
 * Passwords and key passphrases do NOT live in this database. They go to
 * {@link SecretStore}, one small file per (host, kind), so a database copied for
 * backup is not a copied credential store — and deleting a host removes its
 * secret with a single unlink.
 */
final class Db extends SQLiteOpenHelper {

    private static final String NAME = "clawterm.db";
    private static final int VERSION = 1;

    /** Guards every write: the app is single-process, but calls arrive from the
     *  WebView bridge thread and from SSH callbacks. */
    private static final Object LOCK = new Object();

    Db(Context ctx) {
        super(ctx, ctx.getDatabasePath(NAME).getAbsolutePath(), null, VERSION);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE hosts ("
                + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                + "name TEXT NOT NULL,"
                + "address TEXT NOT NULL,"
                + "port INTEGER NOT NULL DEFAULT 22,"
                + "username TEXT NOT NULL,"
                + "auth_type TEXT NOT NULL DEFAULT 'password',"
                + "key_path TEXT NOT NULL DEFAULT '',"
                + "color TEXT NOT NULL DEFAULT '',"
                + "grp TEXT NOT NULL DEFAULT '',"
                + "last_used_at INTEGER NOT NULL DEFAULT 0,"
                + "created_at TEXT NOT NULL,"
                + "updated_at TEXT NOT NULL)");

        db.execSQL("CREATE TABLE snippets ("
                + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                + "label TEXT NOT NULL,"
                + "command TEXT NOT NULL,"
                + "host_id INTEGER NOT NULL DEFAULT 0,"
                + "send INTEGER NOT NULL DEFAULT 1,"
                + "sort_order INTEGER NOT NULL DEFAULT 0,"
                + "created_at TEXT NOT NULL,"
                + "updated_at TEXT NOT NULL)");

        db.execSQL("CREATE TABLE forward_rules ("
                + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                + "host_id INTEGER NOT NULL,"
                + "local_port INTEGER NOT NULL,"
                + "remote_host TEXT NOT NULL DEFAULT '127.0.0.1',"
                + "remote_port INTEGER NOT NULL,"
                + "auto_start INTEGER NOT NULL DEFAULT 0,"
                + "created_at TEXT NOT NULL)");

        db.execSQL("CREATE TABLE known_hosts ("
                + "address TEXT PRIMARY KEY,"
                + "key_type TEXT NOT NULL,"
                + "fingerprint TEXT NOT NULL,"
                + "first_seen TEXT NOT NULL,"
                + "last_seen TEXT NOT NULL)");

        db.execSQL("CREATE TABLE settings ("
                + "key TEXT PRIMARY KEY,"
                + "value TEXT NOT NULL)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // Only version 1 exists. A future migration must be additive here; the
        // alternative (drop and recreate) would silently destroy every host.
    }

    // ── settings helpers ────────────────────────────────────────────────────

    String getSetting(String key, String def) {
        try (Cursor c = getReadableDatabase().rawQuery(
                "SELECT value FROM settings WHERE key = ?", new String[]{key})) {
            return c.moveToFirst() ? c.getString(0) : def;
        }
    }

    void setSetting(String key, String value) {
        synchronized (LOCK) {
            ContentValues v = new ContentValues();
            v.put("key", key);
            v.put("value", value);
            getWritableDatabase().insertWithOnConflict("settings", null, v,
                    SQLiteDatabase.CONFLICT_REPLACE);
        }
    }

    // ── known hosts ─────────────────────────────────────────────────────────

    /** Returns {keyType, fingerprint} or null when the address is unknown. */
    String[] knownHost(String address) {
        try (Cursor c = getReadableDatabase().rawQuery(
                "SELECT key_type, fingerprint FROM known_hosts WHERE address = ?",
                new String[]{address})) {
            if (!c.moveToFirst()) return null;
            return new String[]{c.getString(0), c.getString(1)};
        }
    }

    void pinHost(String address, String keyType, String fingerprint, String now) {
        synchronized (LOCK) {
            ContentValues v = new ContentValues();
            v.put("address", address);
            v.put("key_type", keyType);
            v.put("fingerprint", fingerprint);
            v.put("first_seen", now);
            v.put("last_seen", now);
            getWritableDatabase().insertWithOnConflict("known_hosts", null, v,
                    SQLiteDatabase.CONFLICT_REPLACE);
        }
    }

    void unpinHost(String address) {
        synchronized (LOCK) {
            getWritableDatabase().delete("known_hosts", "address = ?", new String[]{address});
        }
    }

    Object lock() {
        return LOCK;
    }
}
