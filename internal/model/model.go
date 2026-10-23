package model

import "time"

// Host is a saved SSH connection target.
//
// Credentials are deliberately NOT part of this struct: the password (and the
// private-key passphrase) live in a separate, permission-restricted store
// (internal/secret) so that listing hosts never carries secrets over the wire.
type Host struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Address  string `json:"address"` // hostname or IP, no scheme
	Port     int    `json:"port"`
	Username string `json:"username"`
	// AuthType is "password" | "key" | "agent". "agent" uses the local
	// SSH_AUTH_SOCK, which only exists on desktop builds.
	AuthType string `json:"authType"`
	// KeyPath is the absolute path of a private key file (AuthType=key).
	KeyPath string `json:"keyPath"`
	// HasPassword/HasPassphrase tell the UI whether a secret is stored without
	// revealing it. Setting a password writes the secret; leaving the field
	// empty on update keeps the stored one.
	HasPassword   bool `json:"hasPassword"`
	HasPassphrase bool `json:"hasPassphrase"`
	// Color is an optional accent tag (theme-independent hex) used for the
	// host's avatar tile.
	Color string `json:"color"`
	// Group is a free-form folder name used to section the host list.
	Group string `json:"group"`
	// LastUsedAt is a unix-millis timestamp, 0 when never connected.
	LastUsedAt int64     `json:"lastUsedAt"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// Snippet is a saved command, optionally scoped to one host (HostID=0 means
// global). `Send` controls whether a trailing newline is appended on use:
// false lets the user review the command in the shell first.
type Snippet struct {
	ID        int64     `json:"id"`
	Label     string    `json:"label"`
	Command   string    `json:"command"`
	HostID    int64     `json:"hostId"`
	Send      bool      `json:"send"`
	SortOrder int       `json:"sortOrder"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// ForwardRule is a persistent local port-forward definition
// (`127.0.0.1:<LocalPort>` → `<RemoteHost>:<RemotePort>` over the SSH
// connection of HostID).
type ForwardRule struct {
	ID         int64  `json:"id"`
	HostID     int64  `json:"hostId"`
	LocalPort  int    `json:"localPort"`
	RemoteHost string `json:"remoteHost"`
	RemotePort int    `json:"remotePort"`
	// AutoStart re-establishes the rule whenever its host connects.
	AutoStart bool      `json:"autoStart"`
	CreatedAt time.Time `json:"createdAt"`
}

// KnownHost records the host key we accepted for an address, so a changed key
// can be reported as a possible MITM instead of silently re-trusted.
type KnownHost struct {
	Address     string    `json:"address"` // "host:port"
	KeyType     string    `json:"keyType"`
	Fingerprint string    `json:"fingerprint"` // SHA256:base64
	FirstSeen   time.Time `json:"firstSeen"`
	LastSeen    time.Time `json:"lastSeen"`
}
