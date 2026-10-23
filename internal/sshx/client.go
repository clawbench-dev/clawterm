// Package sshx is the SSH/SFTP client layer: dialling with host-key
// verification, interactive shells (PTY) and an SFTP handle.
package sshx

import (
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

// Auth describes how to authenticate. Password and Passphrase are plaintext
// here and only in memory; the caller decrypts them per connection.
type Auth struct {
	Type       string // "password" | "key" | "agent"
	Password   string
	KeyPath    string
	Passphrase string
}

// HostKeyStore is the persistence side of host-key verification. The caller
// (handler layer) owns the implementation; sshx only asks.
type HostKeyStore interface {
	// Lookup returns the pinned fingerprint for "host:port", or "" when unknown.
	Lookup(address string) (keyType, fingerprint string, err error)
	Pin(address, keyType, fingerprint string) error
	Unpin(address string) error
}

// HostKeyMismatch is returned when the server presents a different key than
// the one pinned for this address. The UI must show both fingerprints and only
// retry after the user explicitly accepts (Unpin + reconnect).
type HostKeyMismatch struct {
	Address   string
	OldType   string
	OldFinger string
	NewType   string
	NewFinger string
}

func (e *HostKeyMismatch) Error() string {
	return fmt.Sprintf("host key for %s changed: %s %s → %s %s", e.Address, e.OldType, e.OldFinger, e.NewType, e.NewFinger)
}

// Client is one established SSH connection.
type Client struct {
	Conn *ssh.Client
	Host string
	Port int
	User string

	mu   sync.Mutex
	sftp *sftp.Client
}

// Addr is "host:port".
func (c *Client) Addr() string { return net.JoinHostPort(c.Host, strconv.Itoa(c.Port)) }

// Dial connects and authenticates. It returns *HostKeyMismatch when the pinned
// key differs; a first connection to an unknown address is pinned (TOFU) and
// the fingerprint is reported back through the returned notice string.
func Dial(host string, port int, user string, auth Auth, keys HostKeyStore) (*Client, string, error) {
	if port <= 0 || port > 65535 {
		return nil, "", fmt.Errorf("invalid port %d", port)
	}
	address := net.JoinHostPort(host, strconv.Itoa(port))

	authMethods, closeAgent, err := buildAuth(auth)
	if err != nil {
		return nil, "", err
	}
	defer closeAgent()

	var notice string
	cb := func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		fp := ssh.FingerprintSHA256(key)
		kt := key.Type()
		oldType, oldFP, err := keys.Lookup(address)
		if err != nil {
			return err
		}
		if oldFP == "" {
			if err := keys.Pin(address, kt, fp); err != nil {
				return err
			}
			notice = fmt.Sprintf("first connection: pinned %s %s", kt, fp)
			return nil
		}
		if oldFP != fp {
			return &HostKeyMismatch{Address: address, OldType: oldType, OldFinger: oldFP, NewType: kt, NewFinger: fp}
		}
		return nil
	}

	cfg := &ssh.ClientConfig{
		User:            user,
		Auth:            authMethods,
		HostKeyCallback: cb,
		// The dial timeout below is the real bound; this only guards a server
		// that accepts TCP and then stalls mid-handshake.
		Timeout: 20 * time.Second,
	}
	conn, err := ssh.Dial("tcp", address, cfg)
	if err != nil {
		var mismatch *HostKeyMismatch
		if errors.As(err, &mismatch) {
			return nil, "", mismatch
		}
		return nil, "", friendlyDialError(err)
	}
	return &Client{Conn: conn, Host: host, Port: port, User: user}, notice, nil
}

// DialError is a connection failure attributed to the remote side. The code is
// stable so the UI can branch (and translate) without matching on English text.
type DialError struct {
	Code string
	Err  error
}

func (e *DialError) Error() string { return e.Err.Error() }
func (e *DialError) Unwrap() error { return e.Err }

// Error codes reported to the client.
const (
	CodeAuthFailed = "auth_failed"
	CodeRefused    = "connection_refused"
	CodeTimeout    = "timeout"
	CodeNoHost     = "host_not_found"
	CodeDialFailed = "dial_failed"
)

// friendlyDialError classifies the handful of failures users actually hit.
// Anything else is passed through with a generic code — inventing a friendly
// message for an unknown error hides the real cause.
func friendlyDialError(err error) error {
	msg := err.Error()
	code := CodeDialFailed
	switch {
	case strings.Contains(msg, "unable to authenticate"),
		strings.Contains(msg, "no supported methods remain"),
		// A rejected keyboard-interactive attempt surfaces as a bare protocol
		// mismatch ("unexpected message type 51"), which reads like a bug rather
		// than a wrong password. It is the same failure.
		strings.Contains(msg, "unexpected message type 51"):
		code = CodeAuthFailed
	case strings.Contains(msg, "connection refused"):
		code = CodeRefused
	case strings.Contains(msg, "i/o timeout"), strings.Contains(msg, "context deadline exceeded"):
		code = CodeTimeout
	case strings.Contains(msg, "no such host"):
		code = CodeNoHost
	}
	return &DialError{Code: code, Err: err}
}

func buildAuth(a Auth) ([]ssh.AuthMethod, func(), error) {
	noop := func() {}
	switch a.Type {
	case "agent":
		sock := os.Getenv("SSH_AUTH_SOCK")
		if sock == "" {
			return nil, noop, errors.New("SSH agent requested but SSH_AUTH_SOCK is not set")
		}
		conn, err := net.Dial("unix", sock)
		if err != nil {
			return nil, noop, fmt.Errorf("connect to ssh agent: %w", err)
		}
		ag := agent.NewClient(conn)
		return []ssh.AuthMethod{ssh.PublicKeysCallback(ag.Signers)}, func() { conn.Close() }, nil

	case "key":
		if a.KeyPath == "" {
			return nil, noop, errors.New("key auth selected but no key path given")
		}
		raw, err := os.ReadFile(a.KeyPath)
		if err != nil {
			return nil, noop, fmt.Errorf("read key %s: %w", a.KeyPath, err)
		}
		var signer ssh.Signer
		if a.Passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase(raw, []byte(a.Passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey(raw)
		}
		if err != nil {
			var missing *ssh.PassphraseMissingError
			if errors.As(err, &missing) {
				return nil, noop, errors.New("private key is encrypted: a passphrase is required")
			}
			return nil, noop, fmt.Errorf("parse key %s: %w", a.KeyPath, err)
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, noop, nil

	default: // password
		if a.Password == "" {
			return nil, noop, errors.New("password auth selected but no password stored")
		}
		return []ssh.AuthMethod{
			ssh.Password(a.Password),
			// Some servers only offer keyboard-interactive; many of them treat
			// it as a plain password prompt. Answer every prompt with the same
			// password, which is what every SSH GUI does.
			ssh.KeyboardInteractive(func(_, _ string, questions []string, _ []bool) ([]string, error) {
				answers := make([]string, len(questions))
				for i := range answers {
					answers[i] = a.Password
				}
				return answers, nil
			}),
		}, noop, nil
	}
}

// Close tears down the SFTP handle and the connection.
func (c *Client) Close() error {
	c.mu.Lock()
	if c.sftp != nil {
		c.sftp.Close()
		c.sftp = nil
	}
	c.mu.Unlock()
	return c.Conn.Close()
}

// SFTP returns a lazily created SFTP client for this connection.
func (c *Client) SFTP() (*sftp.Client, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sftp != nil {
		return c.sftp, nil
	}
	sc, err := sftp.NewClient(c.Conn)
	if err != nil {
		return nil, fmt.Errorf("open sftp: %w", err)
	}
	c.sftp = sc
	return sc, nil
}
