package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

type RefreshToken struct {
	ID        string
	UserID    string
	FamilyID  string
	TokenHash string
	ExpiresAt time.Time
	CreatedAt time.Time
	UsedAt    *time.Time
	RevokedAt *time.Time
}

func (q *Queries) CreateRefreshToken(ctx context.Context, t RefreshToken) error {
	_, err := q.db.ExecContext(ctx,
		`INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at, created_at, used_at, revoked_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		t.ID, t.UserID, t.FamilyID, t.TokenHash, formatTime(t.ExpiresAt), formatTime(t.CreatedAt),
		formatNullTime(t.UsedAt), formatNullTime(t.RevokedAt))
	return err
}

func (q *Queries) GetRefreshTokenByHash(ctx context.Context, hash string) (RefreshToken, error) {
	var (
		t                 RefreshToken
		expires, created  string
		usedAt, revokedAt sql.NullString
	)
	err := q.db.QueryRowContext(ctx,
		`SELECT id, user_id, family_id, token_hash, expires_at, created_at, used_at, revoked_at
		 FROM refresh_tokens WHERE token_hash = ?`, hash,
	).Scan(&t.ID, &t.UserID, &t.FamilyID, &t.TokenHash, &expires, &created, &usedAt, &revokedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return RefreshToken{}, ErrNotFound
	}
	if err != nil {
		return RefreshToken{}, err
	}
	if t.ExpiresAt, err = parseTime(expires); err != nil {
		return RefreshToken{}, fmt.Errorf("refresh_tokens.expires_at: %w", err)
	}
	if t.CreatedAt, err = parseTime(created); err != nil {
		return RefreshToken{}, fmt.Errorf("refresh_tokens.created_at: %w", err)
	}
	if t.UsedAt, err = parseNullTime(usedAt); err != nil {
		return RefreshToken{}, fmt.Errorf("refresh_tokens.used_at: %w", err)
	}
	if t.RevokedAt, err = parseNullTime(revokedAt); err != nil {
		return RefreshToken{}, fmt.Errorf("refresh_tokens.revoked_at: %w", err)
	}
	return t, nil
}

// MarkRefreshTokenUsed sets used_at if the token is still unused and not
// revoked. It reports whether the token was marked.
func (q *Queries) MarkRefreshTokenUsed(ctx context.Context, id string, at time.Time) (bool, error) {
	res, err := q.db.ExecContext(ctx,
		`UPDATE refresh_tokens SET used_at = ?
		 WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`,
		formatTime(at), id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

func (q *Queries) RevokeRefreshTokenFamily(ctx context.Context, familyID string, at time.Time) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL`,
		formatTime(at), familyID)
	return err
}

func (q *Queries) RevokeUserRefreshTokens(ctx context.Context, userID string, at time.Time) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
		formatTime(at), userID)
	return err
}

func (q *Queries) DeleteExpiredRefreshTokens(ctx context.Context, now time.Time) (int64, error) {
	res, err := q.db.ExecContext(ctx,
		`DELETE FROM refresh_tokens WHERE expires_at < ?`, formatTime(now))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
