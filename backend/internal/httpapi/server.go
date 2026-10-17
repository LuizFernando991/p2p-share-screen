// Package httpapi exposes the services over a JSON REST API.
package httpapi

import (
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"golang.org/x/time/rate"

	"p2p-share-screen/backend/internal/auth"
	"p2p-share-screen/backend/internal/store"
	"p2p-share-screen/backend/internal/users"
)

type Deps struct {
	Store  *store.Store
	Auth   *auth.Service
	Users  *users.Service
	Logger *slog.Logger
	// TrustProxy takes the client IP from X-Forwarded-For.
	TrustProxy bool
}

type Server struct {
	store      *store.Store
	auth       *auth.Service
	users      *users.Service
	log        *slog.Logger
	trustProxy bool

	loginLimiter *rateLimiter
	handler      http.Handler
}

func New(d Deps) *Server {
	s := &Server{
		store:      d.Store,
		auth:       d.Auth,
		users:      d.Users,
		log:        d.Logger,
		trustProxy: d.TrustProxy,
		// 10 attempts at once, then one every 6 seconds per IP.
		loginLimiter: newRateLimiter(rate.Every(6*time.Second), 10),
	}
	s.handler = s.routes()
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.handler.ServeHTTP(w, r)
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)

	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/auth/refresh", s.handleRefresh)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)

	mux.Handle("GET /api/me", s.authed(s.handleMe))
	mux.Handle("PATCH /api/me/password", s.authed(s.handleChangePassword))

	mux.Handle("GET /api/admin/users", s.admin(s.handleListUsers))
	mux.Handle("POST /api/admin/users", s.admin(s.handleCreateUser))
	mux.Handle("GET /api/admin/users/{id}", s.admin(s.handleGetUser))
	mux.Handle("PATCH /api/admin/users/{id}", s.admin(s.handleUpdateUser))
	mux.Handle("DELETE /api/admin/users/{id}", s.admin(s.handleDeleteUser))

	return s.logRequests(s.recoverPanics(mux))
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if err := s.store.Ping(r.Context()); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) clientIP(r *http.Request) string {
	if s.trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			// The rightmost entry is the one our own proxy appended.
			parts := strings.Split(xff, ",")
			return strings.TrimSpace(parts[len(parts)-1])
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
