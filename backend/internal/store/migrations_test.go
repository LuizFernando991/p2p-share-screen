package store

import (
	"context"
	"database/sql"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pressly/goose/v3"

	"p2p-share-screen/backend/migrations"
)

// 00003 rebuilds rooms; members of existing rooms must survive it and
// restricted rooms must get a code.
func TestMigrationRoomCodesKeepsData(t *testing.T) {
	ctx := context.Background()
	params := url.Values{}
	params.Add("_pragma", "foreign_keys(1)")
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "m.db")+"?"+params.Encode())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	provider, err := goose.NewProvider(goose.DialectSQLite3, db, migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.UpTo(ctx, 2); err != nil {
		t.Fatal(err)
	}

	const ts = "2026-01-01T00:00:00.000000000Z"
	for _, stmt := range []string{
		`INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at, updated_at)
		 VALUES ('u1', 'alice', 'Alice', 'x', 'user', 0, '` + ts + `', '` + ts + `'),
		        ('u2', 'bob', 'Bob', 'x', 'user', 0, '` + ts + `', '` + ts + `')`,
		`INSERT INTO rooms (id, name, type, owner_id, join_code, empty_since, created_at, updated_at)
		 VALUES ('r1', 'Team', 'restricted', 'u1', NULL, NULL, '` + ts + `', '` + ts + `'),
		        ('r2', 'Pair', 'private', 'u1', 'ABCDEFGH', '` + ts + `', '` + ts + `', '` + ts + `')`,
		`INSERT INTO room_members (room_id, user_id, role, can_publish, joined_at)
		 VALUES ('r1', 'u1', 'owner', 1, '` + ts + `'), ('r1', 'u2', 'member', 0, '` + ts + `'),
		        ('r2', 'u1', 'owner', 1, '` + ts + `')`,
	} {
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}

	if err := migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	q := &Queries{db: db}
	fixed, err := q.GetRoom(ctx, "r1")
	if err != nil {
		t.Fatal(err)
	}
	if len(fixed.JoinCode) != 8 {
		t.Fatalf("restricted room code = %q", fixed.JoinCode)
	}
	for _, c := range fixed.JoinCode {
		if !strings.ContainsRune("23456789ABCDEFGHJKLMNPQRSTUVWXYZ", c) {
			t.Fatalf("code %q has a symbol outside the alphabet", fixed.JoinCode)
		}
	}
	if temp, _ := q.GetRoom(ctx, "r2"); temp.JoinCode != "ABCDEFGH" || temp.EmptySince == nil {
		t.Fatalf("private room changed: %+v", temp)
	}
	members, err := q.ListRoomMembers(ctx, "r1")
	if err != nil || len(members) != 2 || members[1].CanPublish {
		t.Fatalf("members after migration: %+v %v", members, err)
	}

	// Foreign keys still cascade from the rebuilt rooms table.
	if err := q.DeleteRoom(ctx, "r1"); err != nil {
		t.Fatal(err)
	}
	if members, _ := q.ListRoomMembers(ctx, "r1"); len(members) != 0 {
		t.Fatalf("members should cascade: %+v", members)
	}
}
