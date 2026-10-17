// Package id generates the identifiers used for every row in the database.
package id

import "github.com/google/uuid"

// New returns a UUIDv7 string, which sorts by creation time.
func New() string {
	return uuid.Must(uuid.NewV7()).String()
}
