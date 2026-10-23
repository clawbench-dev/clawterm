package store

import (
	"errors"
	"path/filepath"
	"testing"

	"clawterm/internal/model"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestCreateAndListHosts(t *testing.T) {
	s := newStore(t)
	h, err := s.CreateHost(&model.Host{
		Name: "prod", Address: "example.com", Port: 22, Username: "root", AuthType: "key",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if h.ID == 0 {
		t.Fatal("expected an assigned id")
	}
	list, err := s.ListHosts()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 1 || list[0].Name != "prod" {
		t.Fatalf("unexpected list: %+v", list)
	}
}

func TestUpdateHost(t *testing.T) {
	s := newStore(t)
	h, _ := s.CreateHost(&model.Host{Name: "a", Address: "h", Port: 22, Username: "u"})
	h.Name = "renamed"
	h.Port = 2222
	if err := s.UpdateHost(h); err != nil {
		t.Fatalf("update: %v", err)
	}
	got, err := s.GetHost(h.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Name != "renamed" || got.Port != 2222 {
		t.Fatalf("update did not stick: %+v", got)
	}
}

func TestUpdateMissingHostIsNotFound(t *testing.T) {
	s := newStore(t)
	err := s.UpdateHost(&model.Host{ID: 999, Name: "x"})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

// Deleting a host must take its snippets and forward rules with it, otherwise
// the UI shows rows pointing at a host that no longer exists.
func TestDeleteHostCascades(t *testing.T) {
	s := newStore(t)
	h, _ := s.CreateHost(&model.Host{Name: "a", Address: "h", Port: 22, Username: "u"})
	if _, err := s.CreateSnippet(&model.Snippet{Label: "l", Command: "ls", HostID: h.ID, Send: true}); err != nil {
		t.Fatalf("snippet: %v", err)
	}
	if _, err := s.CreateForwardRule(&model.ForwardRule{HostID: h.ID, LocalPort: 8080, RemotePort: 80}); err != nil {
		t.Fatalf("rule: %v", err)
	}
	if err := s.DeleteHost(h.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	snips, _ := s.ListSnippets(0)
	if len(snips) != 0 {
		t.Fatalf("expected snippets to be deleted, got %d", len(snips))
	}
	rules, _ := s.ListForwardRules()
	if len(rules) != 0 {
		t.Fatalf("expected rules to be deleted, got %d", len(rules))
	}
}

// Global snippets (hostID 0) are visible from every host; host-scoped ones only
// from their own.
func TestListSnippetsScoping(t *testing.T) {
	s := newStore(t)
	_, _ = s.CreateSnippet(&model.Snippet{Label: "global", Command: "ls", HostID: 0, Send: true})
	_, _ = s.CreateSnippet(&model.Snippet{Label: "host7", Command: "df", HostID: 7, Send: true})
	_, _ = s.CreateSnippet(&model.Snippet{Label: "host8", Command: "du", HostID: 8, Send: true})

	got, err := s.ListSnippets(7)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	labels := map[string]bool{}
	for _, sn := range got {
		labels[sn.Label] = true
	}
	if !labels["global"] || !labels["host7"] || labels["host8"] {
		t.Fatalf("wrong scoping: %+v", labels)
	}
}

func TestReorderSnippets(t *testing.T) {
	s := newStore(t)
	a, _ := s.CreateSnippet(&model.Snippet{Label: "a", Command: "1", Send: true})
	b, _ := s.CreateSnippet(&model.Snippet{Label: "b", Command: "2", Send: true})
	if err := s.ReorderSnippets([]int64{b.ID, a.ID}); err != nil {
		t.Fatalf("reorder: %v", err)
	}
	list, _ := s.ListSnippets(0)
	if len(list) != 2 || list[0].Label != "b" {
		t.Fatalf("unexpected order: %+v", list)
	}
}

func TestKnownHostPinAndChange(t *testing.T) {
	s := newStore(t)
	if _, err := s.GetKnownHost("h:22"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected not found, got %v", err)
	}
	if err := s.SaveKnownHost("h:22", "ssh-ed25519", "SHA256:aaa"); err != nil {
		t.Fatalf("pin: %v", err)
	}
	kh, err := s.GetKnownHost("h:22")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if kh.Fingerprint != "SHA256:aaa" {
		t.Fatalf("wrong fingerprint %q", kh.Fingerprint)
	}
	// Re-pinning must UPDATE, not insert a second row.
	if err := s.SaveKnownHost("h:22", "ssh-ed25519", "SHA256:bbb"); err != nil {
		t.Fatalf("re-pin: %v", err)
	}
	kh, _ = s.GetKnownHost("h:22")
	if kh.Fingerprint != "SHA256:bbb" {
		t.Fatalf("re-pin did not update: %q", kh.Fingerprint)
	}
}

func TestSettingsRoundTrip(t *testing.T) {
	s := newStore(t)
	if got := s.GetSetting("missing", "fallback"); got != "fallback" {
		t.Fatalf("got %q", got)
	}
	if err := s.SetSetting("k", "v1"); err != nil {
		t.Fatalf("set: %v", err)
	}
	if err := s.SetSetting("k", "v2"); err != nil {
		t.Fatalf("overwrite: %v", err)
	}
	if got := s.GetSetting("k", ""); got != "v2" {
		t.Fatalf("got %q", got)
	}
}

// Hosts are ordered by last use so the one you actually connect to is on top.
func TestListHostsOrdersByLastUse(t *testing.T) {
	s := newStore(t)
	a, _ := s.CreateHost(&model.Host{Name: "a", Address: "h", Port: 22, Username: "u"})
	b, _ := s.CreateHost(&model.Host{Name: "b", Address: "h", Port: 22, Username: "u"})
	if err := s.TouchHost(a.ID); err != nil {
		t.Fatalf("touch: %v", err)
	}
	list, _ := s.ListHosts()
	if len(list) != 2 || list[0].ID != a.ID {
		t.Fatalf("expected the touched host first, got %+v", list)
	}
	_ = b
}
