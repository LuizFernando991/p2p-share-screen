package users_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"p2p-share-screen/backend/internal/apperr"
	"p2p-share-screen/backend/internal/auth"
	"p2p-share-screen/backend/internal/store"
	"p2p-share-screen/backend/internal/testutil"
	"p2p-share-screen/backend/internal/users"
)

const pw = "password 1234"

func setup(t *testing.T) (*users.Service, *auth.Service) {
	t.Helper()
	st := testutil.OpenStore(t)
	hasher := auth.NewPasswordHasher(auth.FastPasswordParams)
	authSvc := auth.NewService(st, hasher, auth.Config{
		JWTSecret:  []byte("test-secret-test-secret-test-secret"),
		AccessTTL:  time.Minute,
		RefreshTTL: time.Hour,
	})
	return users.NewService(st, hasher, nil), authSvc
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var ae *apperr.Error
	if !errors.As(err, &ae) || ae.Code != code {
		t.Fatalf("got error %v, want code %q", err, code)
	}
}

func ptr[T any](v T) *T { return &v }

func TestCreate(t *testing.T) {
	ctx := context.Background()
	svc, _ := setup(t)

	u, err := svc.Create(ctx, users.CreateInput{Username: "  Alice ", Password: pw})
	if err != nil {
		t.Fatal(err)
	}
	if u.Username != "alice" || u.DisplayName != "alice" || u.Role != store.RoleUser {
		t.Fatalf("unexpected user: %+v", u)
	}

	cases := []struct {
		name string
		in   users.CreateInput
		code string
	}{
		{"duplicate ignoring case", users.CreateInput{Username: "ALICE", Password: pw}, "username_taken"},
		{"short username", users.CreateInput{Username: "ab", Password: pw}, "invalid_username"},
		{"bad chars", users.CreateInput{Username: "a b c", Password: pw}, "invalid_username"},
		{"weak password", users.CreateInput{Username: "bob", Password: "1234"}, "weak_password"},
		{"bad role", users.CreateInput{Username: "bob", Password: pw, Role: "root"}, "invalid_role"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.Create(ctx, tc.in)
			wantCode(t, err, tc.code)
		})
	}
}

func TestAdminCannotLockThemselvesOut(t *testing.T) {
	ctx := context.Background()
	svc, _ := setup(t)
	admin, _ := svc.Create(ctx, users.CreateInput{Username: "root", Password: pw, Role: store.RoleAdmin})

	_, err := svc.Update(ctx, admin.ID, admin.ID, users.UpdateInput{Disabled: ptr(true)})
	wantCode(t, err, "cannot_modify_self")
	_, err = svc.Update(ctx, admin.ID, admin.ID, users.UpdateInput{Role: ptr(store.RoleUser)})
	wantCode(t, err, "cannot_modify_self")
	wantCode(t, svc.Delete(ctx, admin.ID, admin.ID), "cannot_modify_self")

	if _, err := svc.Update(ctx, admin.ID, admin.ID, users.UpdateInput{DisplayName: ptr("Root")}); err != nil {
		t.Fatalf("renaming self should be allowed: %v", err)
	}
}

func TestDisableAndResetEndSessions(t *testing.T) {
	ctx := context.Background()
	svc, authSvc := setup(t)
	admin, _ := svc.Create(ctx, users.CreateInput{Username: "root", Password: pw, Role: store.RoleAdmin})
	bob, _ := svc.Create(ctx, users.CreateInput{Username: "bob", Password: pw})

	session, _, err := authSvc.Login(ctx, "bob", pw)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Update(ctx, admin.ID, bob.ID, users.UpdateInput{Password: ptr("reset password 1")}); err != nil {
		t.Fatal(err)
	}
	_, err = authSvc.Refresh(ctx, session.RefreshToken)
	wantCode(t, err, "invalid_refresh_token")

	session, _, err = authSvc.Login(ctx, "bob", "reset password 1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Update(ctx, admin.ID, bob.ID, users.UpdateInput{Disabled: ptr(true)}); err != nil {
		t.Fatal(err)
	}
	_, err = authSvc.Refresh(ctx, session.RefreshToken)
	wantCode(t, err, "invalid_refresh_token")
	_, err = authSvc.Authenticate(ctx, session.AccessToken)
	wantCode(t, err, "account_disabled")
}

func TestUpdateAndDeleteMissingUser(t *testing.T) {
	ctx := context.Background()
	svc, _ := setup(t)
	admin, _ := svc.Create(ctx, users.CreateInput{Username: "root", Password: pw, Role: store.RoleAdmin})

	_, err := svc.Update(ctx, admin.ID, "missing", users.UpdateInput{DisplayName: ptr("x")})
	wantCode(t, err, "user_not_found")
	wantCode(t, svc.Delete(ctx, admin.ID, "missing"), "user_not_found")
}
