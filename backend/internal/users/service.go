// Package users implements account management, which only admins can do.
package users

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"p2p-share-screen/backend/internal/apperr"
	"p2p-share-screen/backend/internal/auth"
	"p2p-share-screen/backend/internal/id"
	"p2p-share-screen/backend/internal/store"
)

const maxDisplayNameRunes = 64

var usernameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{2,31}$`)

var (
	errUserNotFound = apperr.NotFound("user_not_found", "user not found")
	errUsernameUsed = apperr.Conflict("username_taken", "username already exists")
	errInvalidRole  = apperr.Invalid("invalid_role", "role must be 'admin' or 'user'")
	errModifySelf   = apperr.Forbidden("cannot_modify_self", "you cannot demote, disable or delete your own account")
)

type Service struct {
	store  *store.Store
	hasher *auth.PasswordHasher
	now    func() time.Time
}

func NewService(st *store.Store, hasher *auth.PasswordHasher) *Service {
	return &Service{store: st, hasher: hasher, now: time.Now}
}

type CreateInput struct {
	Username    string
	DisplayName string
	Password    string
	Role        store.Role // defaults to RoleUser
}

func (s *Service) Create(ctx context.Context, in CreateInput) (store.User, error) {
	username := strings.ToLower(strings.TrimSpace(in.Username))
	if !usernameRe.MatchString(username) {
		return store.User{}, apperr.Invalid("invalid_username",
			"username must be 3-32 characters of a-z, 0-9, '.', '_' or '-', starting with a letter or digit")
	}
	displayName, err := normalizeDisplayName(in.DisplayName, username)
	if err != nil {
		return store.User{}, err
	}
	role := in.Role
	if role == "" {
		role = store.RoleUser
	}
	if !role.Valid() {
		return store.User{}, errInvalidRole
	}
	if err := auth.ValidatePassword(in.Password); err != nil {
		return store.User{}, err
	}
	hash, err := s.hasher.Hash(in.Password)
	if err != nil {
		return store.User{}, err
	}
	now := s.now()
	u := store.User{
		ID:           id.New(),
		Username:     username,
		DisplayName:  displayName,
		PasswordHash: hash,
		Role:         role,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := s.store.CreateUser(ctx, u); err != nil {
		if errors.Is(err, store.ErrConflict) {
			return store.User{}, errUsernameUsed
		}
		return store.User{}, err
	}
	return u, nil
}

func (s *Service) List(ctx context.Context) ([]store.User, error) {
	return s.store.ListUsers(ctx)
}

const directoryLimit = 20

// Directory finds active users by name, so room owners can add members.
func (s *Service) Directory(ctx context.Context, query string) ([]store.User, error) {
	return s.store.SearchActiveUsers(ctx, strings.TrimSpace(query), directoryLimit)
}

func (s *Service) Get(ctx context.Context, userID string) (store.User, error) {
	u, err := s.store.GetUserByID(ctx, userID)
	if errors.Is(err, store.ErrNotFound) {
		return store.User{}, errUserNotFound
	}
	return u, err
}

// UpdateInput holds optional changes; nil fields are left as they are.
type UpdateInput struct {
	DisplayName *string
	Role        *store.Role
	Disabled    *bool
	Password    *string // admin password reset
}

// Update applies in to the user. Disabling the account or resetting its
// password ends all of the user's sessions.
func (s *Service) Update(ctx context.Context, actorID, userID string, in UpdateInput) (store.User, error) {
	if actorID == userID &&
		((in.Role != nil && *in.Role != store.RoleAdmin) || (in.Disabled != nil && *in.Disabled)) {
		return store.User{}, errModifySelf
	}
	if in.Role != nil && !in.Role.Valid() {
		return store.User{}, errInvalidRole
	}
	var hash string
	if in.Password != nil {
		if err := auth.ValidatePassword(*in.Password); err != nil {
			return store.User{}, err
		}
		var err error
		if hash, err = s.hasher.Hash(*in.Password); err != nil {
			return store.User{}, err
		}
	}

	var updated store.User
	err := s.store.WithTx(ctx, func(q *store.Queries) error {
		u, err := q.GetUserByID(ctx, userID)
		if errors.Is(err, store.ErrNotFound) {
			return errUserNotFound
		}
		if err != nil {
			return err
		}
		endSessions := false
		if in.DisplayName != nil {
			if u.DisplayName, err = normalizeDisplayName(*in.DisplayName, u.Username); err != nil {
				return err
			}
		}
		if in.Role != nil {
			u.Role = *in.Role
		}
		if in.Disabled != nil {
			endSessions = endSessions || (*in.Disabled && !u.Disabled)
			u.Disabled = *in.Disabled
		}
		if hash != "" {
			u.PasswordHash = hash
			endSessions = true
		}
		u.UpdatedAt = s.now()
		if err := q.UpdateUser(ctx, u); err != nil {
			return err
		}
		if endSessions {
			if err := q.RevokeUserRefreshTokens(ctx, u.ID, u.UpdatedAt); err != nil {
				return err
			}
		}
		updated = u
		return nil
	})
	return updated, err
}

func (s *Service) Delete(ctx context.Context, actorID, userID string) error {
	if actorID == userID {
		return errModifySelf
	}
	err := s.store.DeleteUser(ctx, userID)
	if errors.Is(err, store.ErrNotFound) {
		return errUserNotFound
	}
	return err
}

func normalizeDisplayName(name, fallback string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return fallback, nil
	}
	if utf8.RuneCountInString(name) > maxDisplayNameRunes {
		return "", apperr.Invalid("invalid_display_name", "display name must have at most 64 characters")
	}
	return name, nil
}
