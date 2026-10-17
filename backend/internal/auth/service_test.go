package auth

import (
	"context"
	"errors"
	"testing"
	"time"

	"p2p-share-screen/backend/internal/apperr"
	"p2p-share-screen/backend/internal/id"
	"p2p-share-screen/backend/internal/store"
	"p2p-share-screen/backend/internal/testutil"
)

const testPassword = "correct horse battery"

func newTestService(t *testing.T) (*Service, *store.Store) {
	t.Helper()
	st := testutil.OpenStore(t)
	svc := NewService(st, NewPasswordHasher(FastPasswordParams), Config{
		JWTSecret:  []byte("test-secret-test-secret-test-secret"),
		AccessTTL:  15 * time.Minute,
		RefreshTTL: 24 * time.Hour,
	})
	return svc, st
}

func createUser(t *testing.T, svc *Service, st *store.Store, username string) store.User {
	t.Helper()
	hash, err := svc.hasher.Hash(testPassword)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	u := store.User{ID: id.New(), Username: username, DisplayName: username, PasswordHash: hash,
		Role: store.RoleUser, CreatedAt: now, UpdatedAt: now}
	if err := st.CreateUser(context.Background(), u); err != nil {
		t.Fatal(err)
	}
	return u
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var ae *apperr.Error
	if !errors.As(err, &ae) || ae.Code != code {
		t.Fatalf("got error %v, want code %q", err, code)
	}
}

func TestPasswordHasher(t *testing.T) {
	h := NewPasswordHasher(FastPasswordParams)
	enc, err := h.Hash("s3cret-pass")
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := h.Verify("s3cret-pass", enc); err != nil || !ok {
		t.Fatalf("Verify(correct) = %v, %v", ok, err)
	}
	if ok, _ := h.Verify("wrong", enc); ok {
		t.Fatal("Verify(wrong) = true")
	}
	if _, err := h.Verify("x", "not-a-hash"); err == nil {
		t.Fatal("Verify(malformed) returned no error")
	}
}

func TestLogin(t *testing.T) {
	ctx := context.Background()
	svc, st := newTestService(t)
	u := createUser(t, svc, st, "alice")

	pair, got, err := svc.Login(ctx, "ALICE", testPassword)
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if got.ID != u.ID || pair.AccessToken == "" || pair.RefreshToken == "" {
		t.Fatalf("unexpected login result: %+v %+v", got, pair)
	}
	if authed, err := svc.Authenticate(ctx, pair.AccessToken); err != nil || authed.ID != u.ID {
		t.Fatalf("authenticate: %v %v", authed, err)
	}

	_, _, err = svc.Login(ctx, "alice", "wrong password")
	wantCode(t, err, "invalid_credentials")
	_, _, err = svc.Login(ctx, "nobody", testPassword)
	wantCode(t, err, "invalid_credentials")

	u.Disabled = true
	if err := st.UpdateUser(ctx, u); err != nil {
		t.Fatal(err)
	}
	_, _, err = svc.Login(ctx, "alice", testPassword)
	wantCode(t, err, "account_disabled")
	_, err = svc.Authenticate(ctx, pair.AccessToken)
	wantCode(t, err, "account_disabled")
}

func TestAuthenticateRejectsBadTokens(t *testing.T) {
	ctx := context.Background()
	svc, st := newTestService(t)
	createUser(t, svc, st, "alice")
	pair, _, err := svc.Login(ctx, "alice", testPassword)
	if err != nil {
		t.Fatal(err)
	}

	_, err = svc.Authenticate(ctx, "garbage")
	wantCode(t, err, "invalid_token")

	other := NewService(st, svc.hasher, Config{JWTSecret: []byte("another-secret-another-secret-xx"), AccessTTL: time.Minute})
	_, err = other.Authenticate(ctx, pair.AccessToken)
	wantCode(t, err, "invalid_token")

	svc.now = func() time.Time { return time.Now().Add(time.Hour) }
	_, err = svc.Authenticate(ctx, pair.AccessToken)
	wantCode(t, err, "invalid_token")
}

func TestRefreshRotationAndReuse(t *testing.T) {
	ctx := context.Background()
	svc, st := newTestService(t)
	createUser(t, svc, st, "alice")
	first, _, err := svc.Login(ctx, "alice", testPassword)
	if err != nil {
		t.Fatal(err)
	}

	second, err := svc.Refresh(ctx, first.RefreshToken)
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if second.RefreshToken == first.RefreshToken {
		t.Fatal("refresh token was not rotated")
	}

	// Reusing the first token signals theft: it fails and kills the family.
	_, err = svc.Refresh(ctx, first.RefreshToken)
	wantCode(t, err, "invalid_refresh_token")
	_, err = svc.Refresh(ctx, second.RefreshToken)
	wantCode(t, err, "invalid_refresh_token")
}

func TestRefreshOtherSessionsSurviveReuse(t *testing.T) {
	ctx := context.Background()
	svc, st := newTestService(t)
	createUser(t, svc, st, "alice")
	a, _, _ := svc.Login(ctx, "alice", testPassword)
	b, _, _ := svc.Login(ctx, "alice", testPassword)

	if _, err := svc.Refresh(ctx, a.RefreshToken); err != nil {
		t.Fatal(err)
	}
	_, _ = svc.Refresh(ctx, a.RefreshToken) // reuse in session a
	if _, err := svc.Refresh(ctx, b.RefreshToken); err != nil {
		t.Fatalf("session b should be unaffected: %v", err)
	}
}

func TestRefreshExpired(t *testing.T) {
	ctx := context.Background()
	svc, st := newTestService(t)
	createUser(t, svc, st, "alice")
	pair, _, _ := svc.Login(ctx, "alice", testPassword)

	svc.now = func() time.Time { return time.Now().Add(25 * time.Hour) }
	_, err := svc.Refresh(ctx, pair.RefreshToken)
	wantCode(t, err, "invalid_refresh_token")
}

func TestLogout(t *testing.T) {
	ctx := context.Background()
	svc, st := newTestService(t)
	createUser(t, svc, st, "alice")
	pair, _, _ := svc.Login(ctx, "alice", testPassword)

	if err := svc.Logout(ctx, pair.RefreshToken); err != nil {
		t.Fatal(err)
	}
	_, err := svc.Refresh(ctx, pair.RefreshToken)
	wantCode(t, err, "invalid_refresh_token")
	if err := svc.Logout(ctx, "unknown"); err != nil {
		t.Fatalf("logout unknown token: %v", err)
	}
}

func TestChangePassword(t *testing.T) {
	ctx := context.Background()
	svc, st := newTestService(t)
	u := createUser(t, svc, st, "alice")
	old, _, _ := svc.Login(ctx, "alice", testPassword)

	_, err := svc.ChangePassword(ctx, u.ID, "wrong", "new password 123")
	wantCode(t, err, "wrong_password")
	_, err = svc.ChangePassword(ctx, u.ID, testPassword, "short")
	wantCode(t, err, "weak_password")

	fresh, err := svc.ChangePassword(ctx, u.ID, testPassword, "new password 123")
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.Refresh(ctx, old.RefreshToken)
	wantCode(t, err, "invalid_refresh_token")
	if _, err := svc.Refresh(ctx, fresh.RefreshToken); err != nil {
		t.Fatalf("new session should work: %v", err)
	}
	if _, _, err := svc.Login(ctx, "alice", "new password 123"); err != nil {
		t.Fatalf("login with new password: %v", err)
	}
}
