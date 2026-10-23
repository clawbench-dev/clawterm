package secret

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSetGetRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := s.Set(7, KindPassword, "hunter2"); err != nil {
		t.Fatalf("set: %v", err)
	}
	got, err := s.Get(7, KindPassword)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got != "hunter2" {
		t.Fatalf("got %q, want hunter2", got)
	}
}

func TestSecretsAreNotPlaintextOnDisk(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	if err := s.Set(1, KindPassword, "supersecretvalue"); err != nil {
		t.Fatalf("set: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "secrets", "1.password"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(raw) == "supersecretvalue" || len(raw) < 20 {
		t.Fatalf("secret appears to be stored in the clear: %q", raw)
	}
}

func TestEmptyValueDeletes(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	_ = s.Set(2, KindPassphrase, "x")
	if !s.Has(2, KindPassphrase) {
		t.Fatal("expected secret to exist")
	}
	if err := s.Set(2, KindPassphrase, ""); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if s.Has(2, KindPassphrase) {
		t.Fatal("expected secret to be deleted")
	}
}

// A secret must not decrypt under a different KIND: the kind is the GCM
// additional data, so a password file renamed to a passphrase file fails loudly
// instead of silently returning the wrong credential.
func TestKindIsBoundAsAdditionalData(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	_ = s.Set(3, KindPassword, "abc")
	// Move the file to the other kind's name.
	if err := os.Rename(
		filepath.Join(dir, "secrets", "3.password"),
		filepath.Join(dir, "secrets", "3.passphrase"),
	); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if _, err := s.Get(3, KindPassphrase); err == nil {
		t.Fatal("expected decryption to fail for a mismatched kind")
	}
}

func TestDeleteHostRemovesEveryKind(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	_ = s.Set(9, KindPassword, "a")
	_ = s.Set(9, KindPassphrase, "b")
	if err := s.DeleteHost(9); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if s.Has(9, KindPassword) || s.Has(9, KindPassphrase) {
		t.Fatal("expected all secrets for the host to be gone")
	}
}

// A corrupt key file must be an error, not a silent regeneration: regenerating
// would make every stored credential undecryptable with no explanation.
func TestCorruptMasterKeyIsRejected(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "secrets"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "secrets", "master.key"), []byte("short"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir); err == nil {
		t.Fatal("expected an error for a corrupt master key")
	}
}
