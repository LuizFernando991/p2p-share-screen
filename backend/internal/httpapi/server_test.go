package httpapi_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	lkauth "github.com/livekit/protocol/auth"

	"p2p-share-screen/backend/internal/auth"
	"p2p-share-screen/backend/internal/httpapi"
	"p2p-share-screen/backend/internal/livekit"
	"p2p-share-screen/backend/internal/rooms"
	"p2p-share-screen/backend/internal/store"
	"p2p-share-screen/backend/internal/testutil"
	"p2p-share-screen/backend/internal/users"
)

type testAPI struct {
	t   *testing.T
	srv *httptest.Server
	st  *store.Store
}

const (
	lkKey    = "test-key"
	lkSecret = "test-livekit-secret-test-livekit-secret"
)

func newTestAPI(t *testing.T) (*testAPI, *users.Service) {
	t.Helper()
	st := testutil.OpenStore(t)
	hasher := auth.NewPasswordHasher(auth.FastPasswordParams)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	// Real LiveKit client against a closed port: tokens and webhook checks are
	// real, server API calls fail fast (and are best effort).
	lk := livekit.New(livekit.Config{URL: "ws://127.0.0.1:1", APIKey: lkKey, APISecret: lkSecret, TokenTTL: time.Minute})
	roomSvc := rooms.NewService(st, lk, rooms.DefaultEmptyGrace, log)
	userSvc := users.NewService(st, hasher, roomSvc)
	api := httpapi.New(httpapi.Deps{
		Store: st,
		Auth: auth.NewService(st, hasher, auth.Config{
			JWTSecret:  []byte("test-secret-test-secret-test-secret"),
			AccessTTL:  time.Minute,
			RefreshTTL: time.Hour,
		}),
		Users:    userSvc,
		Rooms:    roomSvc,
		Webhooks: lk,
		Logger:   log,
	})
	srv := httptest.NewServer(api)
	t.Cleanup(srv.Close)
	return &testAPI{t: t, srv: srv, st: st}, userSvc
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

type roomResp struct {
	ID         string `json:"id"`
	Type       string `json:"type"`
	Temporary  bool   `json:"temporary"`
	JoinCode   string `json:"join_code"`
	MyRole     string `json:"my_role"`
	CanManage  bool   `json:"can_manage"`
	CanPublish bool   `json:"can_publish"`
}

func TestRoomsFlow(t *testing.T) {
	api, userSvc := newTestAPI(t)
	ctx := context.Background()
	userSvc.Create(ctx, users.CreateInput{Username: "alice", DisplayName: "Alice Smith", Password: "alice password"})
	bobUser, _ := userSvc.Create(ctx, users.CreateInput{Username: "bob", Password: "bob password"})
	alice := api.login("alice", "alice password").AccessToken
	bob := api.login("bob", "bob password").AccessToken

	// Any user can search the directory to find people to add.
	var dir struct {
		Users []struct {
			ID       string `json:"id"`
			Username string `json:"username"`
		} `json:"users"`
	}
	if code := api.do("GET", "/api/users?q=smi", bob, nil, &dir); code != 200 || len(dir.Users) != 1 || dir.Users[0].Username != "alice" {
		t.Fatalf("directory: %d %+v", code, dir)
	}

	var temp roomResp
	if code := api.do("POST", "/api/rooms", alice, map[string]string{"name": "Pair", "type": "private"}, &temp); code != 201 {
		t.Fatalf("create: %d", code)
	}
	if !temp.Temporary || len(temp.JoinCode) != 9 || !temp.CanManage || temp.MyRole != "owner" {
		t.Fatalf("created room: %+v", temp)
	}

	var e errResp
	if code := api.do("GET", "/api/rooms/"+temp.ID, bob, nil, &e); code != 404 || e.Error.Code != "room_not_found" {
		t.Fatalf("non-member get: %d %+v", code, e)
	}

	var joined roomResp
	if code := api.do("POST", "/api/rooms/join-by-code", bob, map[string]string{"code": temp.JoinCode}, &joined); code != 200 {
		t.Fatalf("join: %d", code)
	}
	if joined.ID != temp.ID || joined.MyRole != "member" || joined.JoinCode != "" || joined.CanManage || !joined.CanPublish {
		t.Fatalf("member view must not expose the code: %+v", joined)
	}

	var fixed roomResp
	api.do("POST", "/api/rooms", alice, map[string]string{"name": "Team", "type": "restricted"}, &fixed)
	if code := api.do("POST", "/api/rooms/"+fixed.ID+"/members", alice,
		map[string]any{"user_id": bobUser.ID, "can_publish": false}, nil); code != 201 {
		t.Fatalf("add member: %d", code)
	}
	var list struct {
		Rooms []roomResp `json:"rooms"`
	}
	if code := api.do("GET", "/api/rooms", bob, nil, &list); code != 200 || len(list.Rooms) != 2 {
		t.Fatalf("bob rooms: %d %+v", code, list)
	}

	if code := api.do("POST", "/api/rooms/"+fixed.ID+"/owner", alice, map[string]string{"user_id": bobUser.ID}, nil); code != 200 {
		t.Fatalf("transfer: %d", code)
	}
	var members struct {
		Members []struct {
			Username string `json:"username"`
			Role     string `json:"role"`
		} `json:"members"`
	}
	api.do("GET", "/api/rooms/"+fixed.ID+"/members", alice, nil, &members)
	if len(members.Members) != 2 || members.Members[0].Username != "bob" || members.Members[0].Role != "owner" {
		t.Fatalf("members after transfer: %+v", members)
	}

	if code := api.do("DELETE", "/api/rooms/"+temp.ID, bob, nil, &e); code != 403 || e.Error.Code != "not_room_owner" {
		t.Fatalf("member delete: %d %+v", code, e)
	}
	if code := api.do("DELETE", "/api/rooms/"+temp.ID, alice, nil, nil); code != 204 {
		t.Fatalf("owner delete: %d", code)
	}
}

func TestJoinByCodeRateLimit(t *testing.T) {
	api, userSvc := newTestAPI(t)
	userSvc.Create(context.Background(), users.CreateInput{Username: "mallory", Password: "mallory password"})
	tok := api.login("mallory", "mallory password").AccessToken
	last := 0
	for range 11 {
		last = api.do("POST", "/api/rooms/join-by-code", tok, map[string]string{"code": "AAAA-AAAA"}, nil)
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("11th attempt status = %d, want 429", last)
	}
}

func TestJoinToken(t *testing.T) {
	api, userSvc := newTestAPI(t)
	ctx := context.Background()
	alice, _ := userSvc.Create(ctx, users.CreateInput{Username: "alice", DisplayName: "Alice", Password: "alice password"})
	bob, _ := userSvc.Create(ctx, users.CreateInput{Username: "bob", Password: "bob password"})
	userSvc.Create(ctx, users.CreateInput{Username: "carol", Password: "carol password"})
	aliceTok := api.login("alice", "alice password").AccessToken
	bobTok := api.login("bob", "bob password").AccessToken
	carolTok := api.login("carol", "carol password").AccessToken

	var room roomResp
	api.do("POST", "/api/rooms", aliceTok, map[string]string{"name": "Team", "type": "restricted"}, &room)
	api.do("POST", "/api/rooms/"+room.ID+"/members", aliceTok, map[string]any{"user_id": bob.ID, "can_publish": false}, nil)

	type joinResp struct {
		URL   string `json:"livekit_url"`
		Token string `json:"token"`
	}
	grants := func(token string) *lkauth.ClaimGrants {
		t.Helper()
		v, err := lkauth.ParseAPIToken(token)
		if err != nil {
			t.Fatal(err)
		}
		_, claims, err := v.Verify(lkSecret)
		if err != nil {
			t.Fatalf("token does not verify with the LiveKit secret: %v", err)
		}
		return claims
	}

	var jr joinResp
	if code := api.do("POST", "/api/rooms/"+room.ID+"/join-token", aliceTok, nil, &jr); code != 200 {
		t.Fatalf("owner join-token: %d", code)
	}
	g := grants(jr.Token)
	if jr.URL != "ws://127.0.0.1:1" || g.Identity != alice.ID || g.Name != "Alice" ||
		g.Video.Room != room.ID || !g.Video.RoomJoin || !g.Video.GetCanPublish() || !g.Video.GetCanSubscribe() {
		t.Fatalf("owner grants: url=%s %+v %+v", jr.URL, g, g.Video)
	}
	if srcs := g.Video.CanPublishSources; len(srcs) != 2 {
		t.Fatalf("publish sources = %v, want screen share only", srcs)
	}

	api.do("POST", "/api/rooms/"+room.ID+"/join-token", bobTok, nil, &jr)
	if g := grants(jr.Token); g.Video.GetCanPublish() || !g.Video.GetCanSubscribe() {
		t.Fatalf("viewer grants: %+v", g.Video)
	}

	var e errResp
	if code := api.do("POST", "/api/rooms/"+room.ID+"/join-token", carolTok, nil, &e); code != 404 {
		t.Fatalf("non-member join-token: %d %+v", code, e)
	}

	// Live info is omitted (unknown) because LiveKit is unreachable here.
	var got struct {
		Live *struct{} `json:"live"`
	}
	if code := api.do("GET", "/api/rooms/"+room.ID, aliceTok, nil, &got); code != 200 || got.Live != nil {
		t.Fatalf("get room with media down: %d %+v", code, got)
	}
}

func (a *testAPI) webhook(body string, secret string) int {
	a.t.Helper()
	sum := sha256.Sum256([]byte(body))
	token, err := lkauth.NewAccessToken(lkKey, secret).
		SetValidFor(time.Minute).
		SetSha256(base64.StdEncoding.EncodeToString(sum[:])).
		ToJWT()
	if err != nil {
		a.t.Fatal(err)
	}
	req, _ := http.NewRequest("POST", a.srv.URL+"/api/livekit/webhook", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/webhook+json")
	req.Header.Set("Authorization", token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	res.Body.Close()
	return res.StatusCode
}

func TestLiveKitWebhook(t *testing.T) {
	api, userSvc := newTestAPI(t)
	ctx := context.Background()
	userSvc.Create(ctx, users.CreateInput{Username: "alice", Password: "alice password"})
	tok := api.login("alice", "alice password").AccessToken
	var room roomResp
	api.do("POST", "/api/rooms", tok, map[string]string{"name": "Pair", "type": "private"}, &room)

	emptySince := func() *time.Time {
		r, err := api.st.GetRoom(ctx, room.ID)
		if err != nil {
			t.Fatal(err)
		}
		return r.EmptySince
	}

	if code := api.webhook(`{"event":"participant_joined","room":{"name":"`+room.ID+`"}}`, lkSecret); code != 204 {
		t.Fatalf("participant_joined: %d", code)
	}
	if emptySince() != nil {
		t.Fatal("room still marked empty after participant_joined")
	}
	if code := api.webhook(`{"event":"room_finished","room":{"name":"`+room.ID+`"}}`, lkSecret); code != 204 {
		t.Fatalf("room_finished: %d", code)
	}
	if emptySince() == nil {
		t.Fatal("room not marked empty after room_finished")
	}

	// Wrong secret: rejected and ignored.
	if code := api.webhook(`{"event":"participant_joined","room":{"name":"`+room.ID+`"}}`, "wrong-secret-wrong-secret-wrong-secret"); code != 401 {
		t.Fatalf("bad signature: %d", code)
	}
	if emptySince() == nil {
		t.Fatal("unsigned webhook changed state")
	}

	// Body tampered after signing: checksum mismatch.
	sum := sha256.Sum256([]byte(`{"event":"room_finished"}`))
	token, _ := lkauth.NewAccessToken(lkKey, lkSecret).SetValidFor(time.Minute).
		SetSha256(base64.StdEncoding.EncodeToString(sum[:])).ToJWT()
	req, _ := http.NewRequest("POST", api.srv.URL+"/api/livekit/webhook",
		bytes.NewBufferString(`{"event":"participant_joined","room":{"name":"`+room.ID+`"}}`))
	req.Header.Set("Authorization", token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 401 {
		t.Fatalf("tampered body: %d", res.StatusCode)
	}
}
