// Package auth handles login, access tokens (JWT) and rotating refresh
// tokens.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"p2p-share-screen/backend/internal/apperr"
	"p2p-share-screen/backend/internal/id"
	"p2p-share-screen/backend/internal/store"
)

const issuer = "p2p-share-screen"

var (
	errInvalidCredentials = apperr.Unauthorized("invalid_credentials", "invalid username or password")
	errAccountDisabled    = apperr.Forbidden("account_disabled", "account is disabled")
	errInvalidRefresh     = apperr.Unauthorized("invalid_refresh_token", "refresh token is invalid or expired")
	errInvalidAccess      = apperr.Unauthorized("invalid_token", "access token is invalid or expired")
	errWrongPassword      = apperr.Forbidden("wrong_password", "current password is incorrect")
)

type Config struct {
	JWTSecret  []byte
	AccessTTL  time.Duration
	RefreshTTL time.Duration
}

type Service struct {
	store  *store.Store
	hasher *PasswordHasher
	cfg    Config
	now    func() time.Time

	dummyOnce sync.Once
	dummyHash string
}

func NewService(st *store.Store, hasher *PasswordHasher, cfg Config) *Service {
	return &Service{store: st, hasher: hasher, cfg: cfg, now: time.Now}
}

type TokenPair struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
}

// Login checks the credentials and starts a new session (refresh token
// family).
func (s *Service) Login(ctx context.Context, username, password string) (TokenPair, store.User, error) {
	u, err := s.store.GetUserByUsername(ctx, strings.TrimSpace(username))
	if errors.Is(err, store.ErrNotFound) {
		// Spend the same time as a real check so response timing does not
		// reveal which usernames exist.
		_, _ = s.hasher.Verify(password, s.dummy())
		return TokenPair{}, store.User{}, errInvalidCredentials
	}
	if err != nil {
		return TokenPair{}, store.User{}, err
	}
	ok, err := s.hasher.Verify(password, u.PasswordHash)
	if err != nil {
		return TokenPair{}, store.User{}, fmt.Errorf("verify password: %w", err)
	}
	if !ok {
		return TokenPair{}, store.User{}, errInvalidCredentials
	}
	if u.Disabled {
		return TokenPair{}, store.User{}, errAccountDisabled
	}
	pair, err := s.issuePair(ctx, s.store.Queries, u.ID, id.New())
	return pair, u, err
}

// Refresh exchanges a refresh token for a new pair. Each refresh token works
// once; presenting a used one revokes its whole family, since it means the
// token leaked.
func (s *Service) Refresh(ctx context.Context, raw string) (TokenPair, error) {
	var (
		pair     TokenPair
		rejected bool
	)
	err := s.store.WithTx(ctx, func(q *store.Queries) error {
		now := s.now()
		t, err := q.GetRefreshTokenByHash(ctx, hashToken(raw))
		if errors.Is(err, store.ErrNotFound) {
			return errInvalidRefresh
		}
		if err != nil {
			return err
		}
		if t.RevokedAt != nil || !now.Before(t.ExpiresAt) {
			return errInvalidRefresh
		}
		// The revocations below must commit, so they return nil and flag the
		// rejection instead of returning an error.
		if t.UsedAt != nil {
			rejected = true
			return q.RevokeRefreshTokenFamily(ctx, t.FamilyID, now)
		}
		u, err := q.GetUserByID(ctx, t.UserID)
		if err != nil {
			return err
		}
		if u.Disabled {
			rejected = true
			return q.RevokeRefreshTokenFamily(ctx, t.FamilyID, now)
		}
		marked, err := q.MarkRefreshTokenUsed(ctx, t.ID, now)
		if err != nil {
			return err
		}
		if !marked {
			rejected = true
			return q.RevokeRefreshTokenFamily(ctx, t.FamilyID, now)
		}
		pair, err = s.issuePair(ctx, q, u.ID, t.FamilyID)
		return err
	})
	if err != nil {
		return TokenPair{}, err
	}
	if rejected {
		return TokenPair{}, errInvalidRefresh
	}
	return pair, nil
}

// Logout ends the session the refresh token belongs to. Unknown tokens are
// ignored.
func (s *Service) Logout(ctx context.Context, raw string) error {
	t, err := s.store.GetRefreshTokenByHash(ctx, hashToken(raw))
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	return s.store.RevokeRefreshTokenFamily(ctx, t.FamilyID, s.now())
}

// ChangePassword sets a new password, ends every session of the user and
// returns a fresh pair for the caller.
func (s *Service) ChangePassword(ctx context.Context, userID, current, next string) (TokenPair, error) {
	u, err := s.store.GetUserByID(ctx, userID)
	if err != nil {
		return TokenPair{}, err
	}
	ok, err := s.hasher.Verify(current, u.PasswordHash)
	if err != nil {
		return TokenPair{}, fmt.Errorf("verify password: %w", err)
	}
	if !ok {
		return TokenPair{}, errWrongPassword
	}
	if err := ValidatePassword(next); err != nil {
		return TokenPair{}, err
	}
	hash, err := s.hasher.Hash(next)
	if err != nil {
		return TokenPair{}, err
	}
	var pair TokenPair
	err = s.store.WithTx(ctx, func(q *store.Queries) error {
		now := s.now()
		u.PasswordHash = hash
		u.UpdatedAt = now
		if err := q.UpdateUser(ctx, u); err != nil {
			return err
		}
		if err := q.RevokeUserRefreshTokens(ctx, u.ID, now); err != nil {
			return err
		}
		pair, err = s.issuePair(ctx, q, u.ID, id.New())
		return err
	})
	return pair, err
}

// Authenticate validates an access token and loads its user. The user is
// read on every request so disabling an account takes effect immediately.
func (s *Service) Authenticate(ctx context.Context, raw string) (store.User, error) {
	userID, err := s.parseAccessToken(raw)
	if err != nil {
		return store.User{}, errInvalidAccess
	}
	u, err := s.store.GetUserByID(ctx, userID)
	if errors.Is(err, store.ErrNotFound) {
		return store.User{}, errInvalidAccess
	}
	if err != nil {
		return store.User{}, err
	}
	if u.Disabled {
		return store.User{}, errAccountDisabled
	}
	return u, nil
}

// CleanupExpired deletes refresh tokens past their expiry.
func (s *Service) CleanupExpired(ctx context.Context) (int64, error) {
	return s.store.DeleteExpiredRefreshTokens(ctx, s.now())
}

func (s *Service) issuePair(ctx context.Context, q *store.Queries, userID, familyID string) (TokenPair, error) {
	now := s.now()
	access, err := s.issueAccessToken(userID, now)
	if err != nil {
		return TokenPair{}, err
	}
	raw := rand.Text()
	err = q.CreateRefreshToken(ctx, store.RefreshToken{
		ID:        id.New(),
		UserID:    userID,
		FamilyID:  familyID,
		TokenHash: hashToken(raw),
		ExpiresAt: now.Add(s.cfg.RefreshTTL),
		CreatedAt: now,
	})
	if err != nil {
		return TokenPair{}, fmt.Errorf("store refresh token: %w", err)
	}
	return TokenPair{
		AccessToken:  access,
		RefreshToken: raw,
		TokenType:    "Bearer",
		ExpiresIn:    int(s.cfg.AccessTTL.Seconds()),
	}, nil
}

func (s *Service) issueAccessToken(userID string, now time.Time) (string, error) {
	claims := jwt.RegisteredClaims{
		Issuer:    issuer,
		Subject:   userID,
		IssuedAt:  jwt.NewNumericDate(now),
		ExpiresAt: jwt.NewNumericDate(now.Add(s.cfg.AccessTTL)),
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.cfg.JWTSecret)
}

func (s *Service) parseAccessToken(raw string) (string, error) {
	var claims jwt.RegisteredClaims
	_, err := jwt.ParseWithClaims(raw, &claims,
		func(*jwt.Token) (any, error) { return s.cfg.JWTSecret, nil },
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer(issuer),
		jwt.WithExpirationRequired(),
		jwt.WithTimeFunc(s.now),
	)
	if err != nil {
		return "", err
	}
	return claims.Subject, nil
}

func (s *Service) dummy() string {
	s.dummyOnce.Do(func() {
		s.dummyHash, _ = s.hasher.Hash("dummy password for timing")
	})
	return s.dummyHash
}

func hashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}
