package httpapi

import (
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"p2p-share-screen/backend/internal/apperr"
	"p2p-share-screen/backend/internal/store"
)

var (
	errMissingToken    = apperr.Unauthorized("missing_token", "missing bearer token")
	errAdminOnly       = apperr.Forbidden("admin_only", "this action requires an admin")
	errTooManyRequests = apperr.TooManyRequests("too_many_requests", "too many attempts, try again later")
	errInvalidWebhook  = apperr.Unauthorized("invalid_webhook", "webhook signature is invalid")
)

// authedHandler is a handler that runs only for an authenticated user.
type authedHandler func(w http.ResponseWriter, r *http.Request, u store.User)

func (s *Server) authed(h authedHandler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, ok := bearerToken(r)
		if !ok {
			s.writeError(w, r, errMissingToken)
			return
		}
		u, err := s.auth.Authenticate(r.Context(), raw)
		if err != nil {
			s.writeError(w, r, err)
			return
		}
		h(w, r, u)
	})
}

func (s *Server) admin(h authedHandler) http.Handler {
	return s.authed(func(w http.ResponseWriter, r *http.Request, u store.User) {
		if u.Role != store.RoleAdmin {
			s.writeError(w, r, errAdminOnly)
			return
		}
		h(w, r, u)
	})
}

func bearerToken(r *http.Request) (string, bool) {
	scheme, token, ok := strings.Cut(r.Header.Get("Authorization"), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") || token == "" {
		return "", false
	}
	return token, true
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (sr *statusRecorder) WriteHeader(code int) {
	sr.status = code
	sr.ResponseWriter.WriteHeader(code)
}

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		s.log.InfoContext(r.Context(), "request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"duration_ms", time.Since(start).Milliseconds(),
			"ip", s.clientIP(r),
		)
	})
}

func (s *Server) recoverPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v)
				}
				s.log.ErrorContext(r.Context(), "panic", "value", v, "path", r.URL.Path)
				writeJSON(w, http.StatusInternalServerError, errorBody{errorDetail{"internal", "internal server error"}})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// rateLimiter keeps one token bucket per key (e.g. client IP).
type rateLimiter struct {
	mu        sync.Mutex
	limit     rate.Limit
	burst     int
	entries   map[string]*limiterEntry
	lastSweep time.Time
}

type limiterEntry struct {
	lim      *rate.Limiter
	lastSeen time.Time
}

func newRateLimiter(limit rate.Limit, burst int) *rateLimiter {
	return &rateLimiter{limit: limit, burst: burst, entries: map[string]*limiterEntry{}}
}

func (rl *rateLimiter) allow(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	if now.Sub(rl.lastSweep) > time.Minute {
		for k, e := range rl.entries {
			if now.Sub(e.lastSeen) > 10*time.Minute {
				delete(rl.entries, k)
			}
		}
		rl.lastSweep = now
	}
	e, ok := rl.entries[key]
	if !ok {
		e = &limiterEntry{lim: rate.NewLimiter(rl.limit, rl.burst)}
		rl.entries[key] = e
	}
	e.lastSeen = now
	return e.lim.Allow()
}
