package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

type Role string

const (
	RoleAdmin Role = "admin"
	RoleUser  Role = "user"
)

func (r Role) Valid() bool { return r == RoleAdmin || r == RoleUser }

type User struct {
	ID           string
	Username     string
	DisplayName  string
	PasswordHash string
	Role         Role
	Disabled     bool
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

const userColumns = `id, username, display_name, password_hash, role, disabled, created_at, updated_at`

func scanUser(row scanner) (User, error) {
	var (
		u                User
		created, updated string
	)
	err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.PasswordHash, &u.Role, &u.Disabled, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, err
	}
	if u.CreatedAt, err = parseTime(created); err != nil {
		return User{}, fmt.Errorf("users.created_at: %w", err)
	}
	if u.UpdatedAt, err = parseTime(updated); err != nil {
		return User{}, fmt.Errorf("users.updated_at: %w", err)
	}
	return u, nil
}

// CreateUser inserts u. It returns ErrConflict if the username is taken
// (compared case-insensitively).
func (q *Queries) CreateUser(ctx context.Context, u User) error {
	_, err := q.db.ExecContext(ctx,
		`INSERT INTO users (`+userColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		u.ID, u.Username, u.DisplayName, u.PasswordHash, u.Role, u.Disabled,
		formatTime(u.CreatedAt), formatTime(u.UpdatedAt))
	if isUniqueViolation(err) {
		return ErrConflict
	}
	return err
}

func (q *Queries) GetUserByID(ctx context.Context, id string) (User, error) {
	return scanUser(q.db.QueryRowContext(ctx,
		`SELECT `+userColumns+` FROM users WHERE id = ?`, id))
}

// GetUserByUsername matches case-insensitively.
func (q *Queries) GetUserByUsername(ctx context.Context, username string) (User, error) {
	return scanUser(q.db.QueryRowContext(ctx,
		`SELECT `+userColumns+` FROM users WHERE username = ?`, username))
}

func (q *Queries) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := q.db.QueryContext(ctx, `SELECT `+userColumns+` FROM users ORDER BY username`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []User
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

// UpdateUser overwrites the mutable fields of the user with u.ID.
func (q *Queries) UpdateUser(ctx context.Context, u User) error {
	res, err := q.db.ExecContext(ctx,
		`UPDATE users SET display_name = ?, password_hash = ?, role = ?, disabled = ?, updated_at = ?
		 WHERE id = ?`,
		u.DisplayName, u.PasswordHash, u.Role, u.Disabled, formatTime(u.UpdatedAt), u.ID)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

func (q *Queries) DeleteUser(ctx context.Context, id string) error {
	res, err := q.db.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, id)
	if err != nil {
		return err
	}
	return requireAffected(res)
}
