// Package testutil holds helpers shared by tests.
package testutil

import (
	"context"
	"path/filepath"
	"testing"

	"p2p-share-screen/backend/internal/store"
)

// OpenStore opens a migrated database in a temp dir, closed at test end.
func OpenStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}
