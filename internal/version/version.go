// Package version carries the build version. Set with
//
//	-ldflags "-X clawterm/internal/version.Version=v1.2.3"
package version

// Version is "dev" unless stamped by the build.
var Version = "dev"
