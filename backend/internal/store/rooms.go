package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

type RoomType string

const (
	// RoomRestricted is permanent; members are added by the owner.
	RoomRestricted RoomType = "restricted"
	// RoomPrivate is temporary; anyone with the join code can enter.
	RoomPrivate RoomType = "private"
)

func (t RoomType) Valid() bool { return t == RoomRestricted || t == RoomPrivate }

type MemberRole string

const (
	MemberOwner  MemberRole = "owner"
	MemberMember MemberRole = "member"
)

type Room struct {
	ID         string
	Name       string
	Type       RoomType
	OwnerID    string
	JoinCode   string // normalized; empty unless Type is RoomPrivate
	EmptySince *time.Time
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

type RoomMember struct {
	RoomID     string
	UserID     string
	Role       MemberRole
	CanPublish bool
	JoinedAt   time.Time
}

// RoomListing is a room as seen by one user.
type RoomListing struct {
	Room
	OwnerUsername    string
	OwnerDisplayName string
	MyRole           MemberRole // empty if the viewer is not a member
	MyCanPublish     bool
	MemberCount      int
}

// MemberListing is a member with the user's public details.
type MemberListing struct {
	RoomMember
	Username    string
	DisplayName string
	Disabled    bool
}

const roomColumns = `id, name, type, owner_id, join_code, empty_since, created_at, updated_at`

func scanRoomFields(row scanner, extra ...any) (Room, error) {
	var (
		r                Room
		joinCode, empty  sql.NullString
		created, updated string
	)
	dest := append([]any{&r.ID, &r.Name, &r.Type, &r.OwnerID, &joinCode, &empty, &created, &updated}, extra...)
	err := row.Scan(dest...)
	if errors.Is(err, sql.ErrNoRows) {
		return Room{}, ErrNotFound
	}
	if err != nil {
		return Room{}, err
	}
	r.JoinCode = joinCode.String
	if r.EmptySince, err = parseNullTime(empty); err != nil {
		return Room{}, fmt.Errorf("rooms.empty_since: %w", err)
	}
	if r.CreatedAt, err = parseTime(created); err != nil {
		return Room{}, fmt.Errorf("rooms.created_at: %w", err)
	}
	if r.UpdatedAt, err = parseTime(updated); err != nil {
		return Room{}, fmt.Errorf("rooms.updated_at: %w", err)
	}
	return r, nil
}

func nullIfEmpty(s string) sql.NullString {
	return sql.NullString{String: s, Valid: s != ""}
}

// CreateRoom inserts r. It returns ErrConflict if the join code is taken.
func (q *Queries) CreateRoom(ctx context.Context, r Room) error {
	_, err := q.db.ExecContext(ctx,
		`INSERT INTO rooms (`+roomColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		r.ID, r.Name, r.Type, r.OwnerID, nullIfEmpty(r.JoinCode), formatNullTime(r.EmptySince),
		formatTime(r.CreatedAt), formatTime(r.UpdatedAt))
	if isUniqueViolation(err) {
		return ErrConflict
	}
	return err
}

func (q *Queries) GetRoom(ctx context.Context, id string) (Room, error) {
	return scanRoomFields(q.db.QueryRowContext(ctx, `SELECT `+roomColumns+` FROM rooms WHERE id = ?`, id))
}

func (q *Queries) GetRoomByJoinCode(ctx context.Context, code string) (Room, error) {
	return scanRoomFields(q.db.QueryRowContext(ctx, `SELECT `+roomColumns+` FROM rooms WHERE join_code = ?`, code))
}

// UpdateRoom overwrites name, owner and join code. It returns ErrConflict if
// the join code is taken.
func (q *Queries) UpdateRoom(ctx context.Context, r Room) error {
	res, err := q.db.ExecContext(ctx,
		`UPDATE rooms SET name = ?, owner_id = ?, join_code = ?, updated_at = ? WHERE id = ?`,
		r.Name, r.OwnerID, nullIfEmpty(r.JoinCode), formatTime(r.UpdatedAt), r.ID)
	if isUniqueViolation(err) {
		return ErrConflict
	}
	if err != nil {
		return err
	}
	return requireAffected(res)
}

// SetRoomEmptySince records when the room became empty (nil: occupied).
func (q *Queries) SetRoomEmptySince(ctx context.Context, id string, at *time.Time) error {
	res, err := q.db.ExecContext(ctx, `UPDATE rooms SET empty_since = ? WHERE id = ?`, formatNullTime(at), id)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

func (q *Queries) DeleteRoom(ctx context.Context, id string) error {
	res, err := q.db.ExecContext(ctx, `DELETE FROM rooms WHERE id = ?`, id)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

// TouchRoomEmptySince restarts the empty grace period of a room that is
// currently marked empty.
func (q *Queries) TouchRoomEmptySince(ctx context.Context, id string, at time.Time) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE rooms SET empty_since = ? WHERE id = ? AND empty_since IS NOT NULL`, formatTime(at), id)
	return err
}

// DeletePrivateRoomIfEmptySince deletes the private room only if it is still
// marked empty since before cutoff. It reports whether it was deleted.
func (q *Queries) DeletePrivateRoomIfEmptySince(ctx context.Context, id string, cutoff time.Time) (bool, error) {
	res, err := q.db.ExecContext(ctx,
		`DELETE FROM rooms WHERE id = ? AND type = 'private' AND empty_since IS NOT NULL AND empty_since < ?`,
		id, formatTime(cutoff))
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// ListEmptyPrivateRooms returns the ids of private rooms empty since before
// cutoff.
func (q *Queries) ListEmptyPrivateRooms(ctx context.Context, cutoff time.Time) ([]string, error) {
	rows, err := q.db.QueryContext(ctx,
		`SELECT id FROM rooms WHERE type = 'private' AND empty_since IS NOT NULL AND empty_since < ?`,
		formatTime(cutoff))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// Listing query: rooms joined with their owner and the viewer's membership.
const roomListingSelect = `
SELECT r.id, r.name, r.type, r.owner_id, r.join_code, r.empty_since, r.created_at, r.updated_at,
       o.username, o.display_name, m.role, m.can_publish,
       (SELECT COUNT(*) FROM room_members c WHERE c.room_id = r.id)
FROM rooms r
JOIN users o ON o.id = r.owner_id
LEFT JOIN room_members m ON m.room_id = r.id AND m.user_id = ?`

func scanRoomListing(row scanner) (RoomListing, error) {
	var (
		l          RoomListing
		role       sql.NullString
		canPublish sql.NullBool
	)
	r, err := scanRoomFields(row, &l.OwnerUsername, &l.OwnerDisplayName, &role, &canPublish, &l.MemberCount)
	if err != nil {
		return RoomListing{}, err
	}
	l.Room = r
	l.MyRole = MemberRole(role.String)
	l.MyCanPublish = canPublish.Bool
	return l, nil
}

// GetRoomListing returns the room as seen by viewerID, member or not.
func (q *Queries) GetRoomListing(ctx context.Context, roomID, viewerID string) (RoomListing, error) {
	return scanRoomListing(q.db.QueryRowContext(ctx, roomListingSelect+` WHERE r.id = ?`, viewerID, roomID))
}

// ListRooms returns the rooms viewerID is a member of, or every room if all.
func (q *Queries) ListRooms(ctx context.Context, viewerID string, all bool) ([]RoomListing, error) {
	rows, err := q.db.QueryContext(ctx,
		roomListingSelect+` WHERE ? OR m.user_id IS NOT NULL ORDER BY r.name COLLATE NOCASE, r.id`,
		viewerID, all)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RoomListing
	for rows.Next() {
		l, err := scanRoomListing(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// AddRoomMember returns ErrConflict if the user is already a member.
func (q *Queries) AddRoomMember(ctx context.Context, m RoomMember) error {
	_, err := q.db.ExecContext(ctx,
		`INSERT INTO room_members (room_id, user_id, role, can_publish, joined_at) VALUES (?, ?, ?, ?, ?)`,
		m.RoomID, m.UserID, m.Role, m.CanPublish, formatTime(m.JoinedAt))
	if isUniqueViolation(err) {
		return ErrConflict
	}
	return err
}

func (q *Queries) GetRoomMember(ctx context.Context, roomID, userID string) (RoomMember, error) {
	var (
		m      RoomMember
		joined string
	)
	err := q.db.QueryRowContext(ctx,
		`SELECT room_id, user_id, role, can_publish, joined_at FROM room_members WHERE room_id = ? AND user_id = ?`,
		roomID, userID,
	).Scan(&m.RoomID, &m.UserID, &m.Role, &m.CanPublish, &joined)
	if errors.Is(err, sql.ErrNoRows) {
		return RoomMember{}, ErrNotFound
	}
	if err != nil {
		return RoomMember{}, err
	}
	if m.JoinedAt, err = parseTime(joined); err != nil {
		return RoomMember{}, fmt.Errorf("room_members.joined_at: %w", err)
	}
	return m, nil
}

// ListRoomMembers returns the owner first, then members by username.
func (q *Queries) ListRoomMembers(ctx context.Context, roomID string) ([]MemberListing, error) {
	rows, err := q.db.QueryContext(ctx,
		`SELECT m.room_id, m.user_id, m.role, m.can_publish, m.joined_at, u.username, u.display_name, u.disabled
		 FROM room_members m JOIN users u ON u.id = m.user_id
		 WHERE m.room_id = ?
		 ORDER BY m.role = 'owner' DESC, u.username`, roomID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MemberListing
	for rows.Next() {
		var (
			l      MemberListing
			joined string
		)
		if err := rows.Scan(&l.RoomID, &l.UserID, &l.Role, &l.CanPublish, &joined,
			&l.Username, &l.DisplayName, &l.Disabled); err != nil {
			return nil, err
		}
		if l.JoinedAt, err = parseTime(joined); err != nil {
			return nil, fmt.Errorf("room_members.joined_at: %w", err)
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// UpdateRoomMember overwrites role and can_publish.
func (q *Queries) UpdateRoomMember(ctx context.Context, m RoomMember) error {
	res, err := q.db.ExecContext(ctx,
		`UPDATE room_members SET role = ?, can_publish = ? WHERE room_id = ? AND user_id = ?`,
		m.Role, m.CanPublish, m.RoomID, m.UserID)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

func (q *Queries) DeleteRoomMember(ctx context.Context, roomID, userID string) error {
	res, err := q.db.ExecContext(ctx, `DELETE FROM room_members WHERE room_id = ? AND user_id = ?`, roomID, userID)
	if err != nil {
		return err
	}
	return requireAffected(res)
}
