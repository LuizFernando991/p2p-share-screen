package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"p2p-share-screen/backend/internal/auth"
	"p2p-share-screen/backend/internal/httpapi"
	"p2p-share-screen/backend/internal/store"
	"p2p-share-screen/backend/internal/testutil"
	"p2p-share-screen/backend/internal/users"
)

type testAPI struct {
	t   *testing.T
	srv *httptest.Server
}

func newTestAPI(t *testing.T) (*testAPI, *users.Service) {
	t.Helper()
	st := testutil.OpenStore(t)
	hasher := auth.NewPasswordHasher(auth.FastPasswordParams)
	userSvc := users.NewService(st, hasher)
	api := httpapi.New(httpapi.Deps{
		Store: st,
		Auth: auth.NewService(st, hasher, auth.Config{
			JWTSecret:  []byte("test-secret-test-secret-test-secret"),
			AccessTTL:  time.Minute,
			RefreshTTL: time.Hour,
		}),
		Users:  userSvc,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	srv := httptest.NewServer(api)
	t.Cleanup(srv.Close)
	return &testAPI{t: t, srv: srv}, userSvc
}

// do sends a JSON request and decodes the JSON response into out (if non-nil).
func (a *testAPI) do(method, path, token string, body any, out any) int {
	a.t.Helper()
	var r io.Reader
	if body != nil {
		if s, ok := body.(string); ok {
			r = bytes.NewBufferString(s)
		} else {
			b, _ := json.Marshal(body)
			r = bytes.NewReader(b)
		}
	}
	req, _ := http.NewRequest(method, a.srv.URL+path, r)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer res.Body.Close()
	if out != nil {
		if err := json.NewDecoder(res.Body).Decode(out); err != nil {
			a.t.Fatalf("%s %s: decode response: %v", method, path, err)
		}
	}
	return res.StatusCode
}

type errResp struct {
	Error struct {
		Code string `json:"code"`
	} `json:"error"`
}

type loginResp struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	User         struct {
		ID   string `json:"id"`
		Role string `json:"role"`
	} `json:"user"`
}

func (a *testAPI) login(username, password string) loginResp {
	a.t.Helper()
	var lr loginResp
	if code := a.do("POST", "/api/auth/login", "", map[string]string{"username": username, "password": password}, &lr); code != 200 {
		a.t.Fatalf("login %s: status %d", username, code)
	}
	return lr
}

func TestAuthAndAdminFlow(t *testing.T) {
	api, userSvc := newTestAPI(t)
	if _, err := userSvc.Create(context.Background(), users.CreateInput{
		Username: "root", Password: "admin password", Role: store.RoleAdmin,
	}); err != nil {
		t.Fatal(err)
	}

	admin := api.login("root", "admin password")
	if admin.User.Role != "admin" {
		t.Fatalf("role = %q", admin.User.Role)
	}

	var me struct {
		Username     string `json:"username"`
		PasswordHash string `json:"password_hash"`
	}
	if code := api.do("GET", "/api/me", admin.AccessToken, nil, &me); code != 200 || me.Username != "root" {
		t.Fatalf("me: %d %+v", code, me)
	}
	if me.PasswordHash != "" {
		t.Fatal("password hash leaked")
	}

	var created struct {
		ID string `json:"id"`
	}
	if code := api.do("POST", "/api/admin/users", admin.AccessToken,
		map[string]string{"username": "bob", "password": "bob password"}, &created); code != 201 {
		t.Fatalf("create user: %d", code)
	}

	var e errResp
	if code := api.do("POST", "/api/admin/users", admin.AccessToken,
		map[string]string{"username": "bob", "password": "bob password"}, &e); code != 409 || e.Error.Code != "username_taken" {
		t.Fatalf("duplicate: %d %+v", code, e)
	}

	bob := api.login("bob", "bob password")
	if code := api.do("GET", "/api/admin/users", bob.AccessToken, nil, &e); code != 403 || e.Error.Code != "admin_only" {
		t.Fatalf("user on admin route: %d %+v", code, e)
	}

	var list struct {
		Users []struct{ Username string } `json:"users"`
	}
	if code := api.do("GET", "/api/admin/users", admin.AccessToken, nil, &list); code != 200 || len(list.Users) != 2 {
		t.Fatalf("list: %d %+v", code, list)
	}

	if code := api.do("PATCH", "/api/admin/users/"+created.ID, admin.AccessToken,
		map[string]bool{"disabled": true}, nil); code != 200 {
		t.Fatalf("disable: %d", code)
	}
	if code := api.do("GET", "/api/me", bob.AccessToken, nil, &e); code != 403 || e.Error.Code != "account_disabled" {
		t.Fatalf("disabled user: %d %+v", code, e)
	}

	if code := api.do("DELETE", "/api/admin/users/"+created.ID, admin.AccessToken, nil, nil); code != 204 {
		t.Fatalf("delete: %d", code)
	}
	if code := api.do("GET", "/api/admin/users/"+created.ID, admin.AccessToken, nil, &e); code != 404 {
		t.Fatalf("get deleted: %d", code)
	}
}

func TestRefreshAndLogout(t *testing.T) {
	api, userSvc := newTestAPI(t)
	userSvc.Create(context.Background(), users.CreateInput{Username: "alice", Password: "alice password"})
	lr := api.login("alice", "alice password")

	var pair loginResp
	if code := api.do("POST", "/api/auth/refresh", "", map[string]string{"refresh_token": lr.RefreshToken}, &pair); code != 200 {
		t.Fatalf("refresh: %d", code)
	}
	if code := api.do("POST", "/api/auth/logout", "", map[string]string{"refresh_token": pair.RefreshToken}, nil); code != 204 {
		t.Fatalf("logout: %d", code)
	}
	var e errResp
	if code := api.do("POST", "/api/auth/refresh", "", map[string]string{"refresh_token": pair.RefreshToken}, &e); code != 401 {
		t.Fatalf("refresh after logout: %d %+v", code, e)
	}
}

func TestErrors(t *testing.T) {
	api, _ := newTestAPI(t)
	var e errResp

	if code := api.do("GET", "/api/me", "", nil, &e); code != 401 || e.Error.Code != "missing_token" {
		t.Fatalf("no token: %d %+v", code, e)
	}
	if code := api.do("GET", "/api/me", "nope", nil, &e); code != 401 || e.Error.Code != "invalid_token" {
		t.Fatalf("bad token: %d %+v", code, e)
	}
	if code := api.do("POST", "/api/auth/login", "", `{"username":"a","password":"b","extra":1}`, &e); code != 400 || e.Error.Code != "invalid_body" {
		t.Fatalf("unknown field: %d %+v", code, e)
	}
	if code := api.do("POST", "/api/auth/login", "", map[string]string{"username": "x", "password": "y"}, &e); code != 401 || e.Error.Code != "invalid_credentials" {
		t.Fatalf("bad login: %d %+v", code, e)
	}
}

func TestLoginRateLimit(t *testing.T) {
	api, _ := newTestAPI(t)
	last := 0
	for range 11 {
		last = api.do("POST", "/api/auth/login", "", map[string]string{"username": "x", "password": "y"}, nil)
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("11th attempt status = %d, want 429", last)
	}
}
