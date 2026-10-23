package store

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"

	"clawterm/internal/model"
)

// ErrNotFound is returned by every lookup that found no row.
var ErrNotFound = errors.New("not found")

// Store is the single SQLite handle for the app. All writes go through one
// mutex: the workload is a handful of interactive edits, so serialising is
// cheaper than a pool and removes every "database is locked" case (SQLite only
// allows one writer anyway, and busy-waiting would surface as UI stalls).
type Store struct {
	db *sql.DB
	mu sync.Mutex
}

// Open creates (or opens) the database at dir/clawterm.db and applies the
// schema. dir is created if missing.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	path := filepath.Join(dir, "clawterm.db")
	// _pragma args are applied per connection by the driver.
	dsn := "file:" + path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// One connection keeps the pragmas (and the write lock) coherent.
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

const schema = `
CREATE TABLE IF NOT EXISTS hosts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    address      TEXT    NOT NULL,
    port         INTEGER NOT NULL DEFAULT 22,
    username     TEXT    NOT NULL,
    auth_type    TEXT    NOT NULL DEFAULT 'password',
    key_path     TEXT    NOT NULL DEFAULT '',
    color        TEXT    NOT NULL DEFAULT '',
    grp          TEXT    NOT NULL DEFAULT '',
    last_used_at INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMP NOT NULL,
    updated_at   TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS snippets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    label      TEXT    NOT NULL,
    command    TEXT    NOT NULL,
    host_id    INTEGER NOT NULL DEFAULT 0,
    send       INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS forward_rules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id     INTEGER NOT NULL,
    local_port  INTEGER NOT NULL,
    remote_host TEXT    NOT NULL DEFAULT '127.0.0.1',
    remote_port INTEGER NOT NULL,
    auto_start  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS known_hosts (
    address     TEXT PRIMARY KEY,
    key_type    TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    first_seen  TIMESTAMP NOT NULL,
    last_seen   TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`

func (s *Store) migrate() error {
	_, err := s.db.Exec(schema)
	return err
}

// ── Hosts ────────────────────────────────────────────────────────────────────

const hostCols = `id, name, address, port, username, auth_type, key_path, color, grp, last_used_at, created_at, updated_at`

func scanHost(sc interface{ Scan(...any) error }) (*model.Host, error) {
	var h model.Host
	err := sc.Scan(&h.ID, &h.Name, &h.Address, &h.Port, &h.Username, &h.AuthType,
		&h.KeyPath, &h.Color, &h.Group, &h.LastUsedAt, &h.CreatedAt, &h.UpdatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &h, nil
}

// ListHosts returns all hosts, most recently used first (then by name).
func (s *Store) ListHosts() ([]*model.Host, error) {
	rows, err := s.db.Query(`SELECT ` + hostCols + ` FROM hosts ORDER BY last_used_at DESC, name COLLATE NOCASE ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*model.Host{}
	for rows.Next() {
		h, err := scanHost(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

func (s *Store) GetHost(id int64) (*model.Host, error) {
	return scanHost(s.db.QueryRow(`SELECT `+hostCols+` FROM hosts WHERE id = ?`, id))
}

// CreateHost inserts h (ignoring h.ID) and returns the stored row.
func (s *Store) CreateHost(h *model.Host) (*model.Host, error) {
	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`INSERT INTO hosts (name, address, port, username, auth_type, key_path, color, grp, last_used_at, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,0,?,?)`,
		h.Name, h.Address, h.Port, h.Username, h.AuthType, h.KeyPath, h.Color, h.Group, now, now)
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	return s.GetHost(id)
}

// UpdateHost rewrites every editable column of h.
func (s *Store) UpdateHost(h *model.Host) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`UPDATE hosts SET name=?, address=?, port=?, username=?, auth_type=?, key_path=?, color=?, grp=?, updated_at=? WHERE id=?`,
		h.Name, h.Address, h.Port, h.Username, h.AuthType, h.KeyPath, h.Color, h.Group, time.Now().UTC(), h.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// TouchHost records a successful connection (drives list ordering).
func (s *Store) TouchHost(id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE hosts SET last_used_at=? WHERE id=?`, time.Now().UnixMilli(), id)
	return err
}

// DeleteHost removes the host plus its snippets and forward rules. Secrets are
// removed by the caller (they live outside the database).
func (s *Store) DeleteHost(id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.db.Exec(`DELETE FROM hosts WHERE id=?`, id); err != nil {
		return err
	}
	if _, err := s.db.Exec(`DELETE FROM snippets WHERE host_id=?`, id); err != nil {
		return err
	}
	_, err := s.db.Exec(`DELETE FROM forward_rules WHERE host_id=?`, id)
	return err
}

// ── Snippets ─────────────────────────────────────────────────────────────────

// ListSnippets returns global snippets plus those scoped to hostID (pass 0 for
// globals only).
func (s *Store) ListSnippets(hostID int64) ([]*model.Snippet, error) {
	rows, err := s.db.Query(`SELECT id, label, command, host_id, send, sort_order, created_at, updated_at
        FROM snippets WHERE host_id = 0 OR host_id = ? ORDER BY sort_order ASC, id ASC`, hostID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*model.Snippet{}
	for rows.Next() {
		var sn model.Snippet
		if err := rows.Scan(&sn.ID, &sn.Label, &sn.Command, &sn.HostID, &sn.Send,
			&sn.SortOrder, &sn.CreatedAt, &sn.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, &sn)
	}
	return out, rows.Err()
}

func (s *Store) CreateSnippet(sn *model.Snippet) (*model.Snippet, error) {
	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`INSERT INTO snippets (label, command, host_id, send, sort_order, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?)`, sn.Label, sn.Command, sn.HostID, sn.Send, sn.SortOrder, now, now)
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	sn.ID = id
	sn.CreatedAt, sn.UpdatedAt = now, now
	return sn, nil
}

func (s *Store) UpdateSnippet(sn *model.Snippet) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`UPDATE snippets SET label=?, command=?, send=?, sort_order=?, updated_at=? WHERE id=?`,
		sn.Label, sn.Command, sn.Send, sn.SortOrder, time.Now().UTC(), sn.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) DeleteSnippet(id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`DELETE FROM snippets WHERE id=?`, id)
	return err
}

// ReorderSnippets writes sort_order = index for each id, in one transaction.
func (s *Store) ReorderSnippets(ids []int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for i, id := range ids {
		if _, err := tx.Exec(`UPDATE snippets SET sort_order=? WHERE id=?`, i, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ── Forward rules ────────────────────────────────────────────────────────────

func (s *Store) ListForwardRules() ([]*model.ForwardRule, error) {
	rows, err := s.db.Query(`SELECT id, host_id, local_port, remote_host, remote_port, auto_start, created_at
        FROM forward_rules ORDER BY id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*model.ForwardRule{}
	for rows.Next() {
		var r model.ForwardRule
		if err := rows.Scan(&r.ID, &r.HostID, &r.LocalPort, &r.RemoteHost, &r.RemotePort,
			&r.AutoStart, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}

func (s *Store) CreateForwardRule(r *model.ForwardRule) (*model.ForwardRule, error) {
	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`INSERT INTO forward_rules (host_id, local_port, remote_host, remote_port, auto_start, created_at)
        VALUES (?,?,?,?,?,?)`, r.HostID, r.LocalPort, r.RemoteHost, r.RemotePort, r.AutoStart, now)
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	r.ID = id
	r.CreatedAt = now
	return r, nil
}

func (s *Store) DeleteForwardRule(id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`DELETE FROM forward_rules WHERE id=?`, id)
	return err
}

// ── Known hosts ──────────────────────────────────────────────────────────────

// GetKnownHost looks up the pinned key for address ("host:port").
func (s *Store) GetKnownHost(address string) (*model.KnownHost, error) {
	var k model.KnownHost
	err := s.db.QueryRow(`SELECT address, key_type, fingerprint, first_seen, last_seen FROM known_hosts WHERE address=?`, address).
		Scan(&k.Address, &k.KeyType, &k.Fingerprint, &k.FirstSeen, &k.LastSeen)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &k, nil
}

// SaveKnownHost pins (or refreshes) the key for address.
func (s *Store) SaveKnownHost(address, keyType, fingerprint string) error {
	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`INSERT INTO known_hosts (address, key_type, fingerprint, first_seen, last_seen)
        VALUES (?,?,?,?,?)
        ON CONFLICT(address) DO UPDATE SET key_type=excluded.key_type, fingerprint=excluded.fingerprint, last_seen=excluded.last_seen`,
		address, keyType, fingerprint, now, now)
	return err
}

// DeleteKnownHost forgets a pinned key (used when the user accepts a change).
func (s *Store) DeleteKnownHost(address string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`DELETE FROM known_hosts WHERE address=?`, address)
	return err
}

// ── Settings (key/value) ─────────────────────────────────────────────────────

func (s *Store) GetSetting(key, def string) string {
	var v string
	err := s.db.QueryRow(`SELECT value FROM settings WHERE key=?`, key).Scan(&v)
	if err != nil {
		return def
	}
	return v
}

func (s *Store) SetSetting(key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`INSERT INTO settings (key, value) VALUES (?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return err
}
