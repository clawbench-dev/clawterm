// Package secret stores SSH credentials outside the database, one small file
// per host, encrypted with a machine-local key.
//
// Why not the database: the DB is a plain SQLite file that users copy around
// (backup, sync, "move my hosts to the new phone"). Keeping secrets in a
// separate directory means a copied DB is not a copied credential store, and
// deleting a host can drop its secret with a single unlink.
//
// Why encryption at all, given the key sits next to the data: it raises the
// bar for the realistic accident (the DB or a log/backup containing the
// directory gets shared) and makes the file non-greppable. It is NOT a defence
// against an attacker who can already read the app's private data directory —
// on Android that boundary is the OS sandbox, not this key.
package secret

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const keyFile = "master.key"

// Store keeps secrets in <dir>/secrets/<hostID>.<kind>.
type Store struct {
	dir  string
	aead cipher.AEAD
}

// Open loads (or creates) the master key under dir and returns the store.
func Open(dir string) (*Store, error) {
	secDir := filepath.Join(dir, "secrets")
	if err := os.MkdirAll(secDir, 0o700); err != nil {
		return nil, fmt.Errorf("create secrets dir: %w", err)
	}
	keyPath := filepath.Join(secDir, keyFile)
	raw, err := os.ReadFile(keyPath)
	if errors.Is(err, os.ErrNotExist) {
		raw = make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			return nil, err
		}
		if err := os.WriteFile(keyPath, raw, 0o600); err != nil {
			return nil, fmt.Errorf("write master key: %w", err)
		}
	} else if err != nil {
		return nil, err
	}
	if len(raw) != 32 {
		return nil, fmt.Errorf("master key %s is corrupt (want 32 bytes, got %d)", keyPath, len(raw))
	}
	block, err := aes.NewCipher(raw)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Store{dir: secDir, aead: aead}, nil
}

func (s *Store) path(hostID int64, kind string) string {
	return filepath.Join(s.dir, fmt.Sprintf("%d.%s", hostID, kind))
}

// Set encrypts and writes value under (hostID, kind). An empty value deletes
// the entry, so the caller can express "clear the password" with the same call.
func (s *Store) Set(hostID int64, kind, value string) error {
	p := s.path(hostID, kind)
	if value == "" {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	sealed := s.aead.Seal(nonce, nonce, []byte(value), []byte(kind))
	return os.WriteFile(p, []byte(base64.StdEncoding.EncodeToString(sealed)), 0o600)
}

// Get returns the decrypted value, or "" when absent.
func (s *Store) Get(hostID int64, kind string) (string, error) {
	raw, err := os.ReadFile(s.path(hostID, kind))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	sealed, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil {
		return "", fmt.Errorf("decode secret %d.%s: %w", hostID, kind, err)
	}
	ns := s.aead.NonceSize()
	if len(sealed) < ns {
		return "", fmt.Errorf("secret %d.%s is truncated", hostID, kind)
	}
	plain, err := s.aead.Open(nil, sealed[:ns], sealed[ns:], []byte(kind))
	if err != nil {
		return "", fmt.Errorf("decrypt secret %d.%s: %w", hostID, kind, err)
	}
	return string(plain), nil
}

// Has reports whether a secret exists, without decrypting it.
func (s *Store) Has(hostID int64, kind string) bool {
	_, err := os.Stat(s.path(hostID, kind))
	return err == nil
}

// DeleteHost removes every secret belonging to hostID.
func (s *Store) DeleteHost(hostID int64) error {
	for _, kind := range []string{KindPassword, KindPassphrase} {
		if err := os.Remove(s.path(hostID, kind)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

// Secret kinds.
const (
	KindPassword   = "password"
	KindPassphrase = "passphrase"
)
