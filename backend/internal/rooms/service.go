// Package rooms implements rooms, their members and invite codes. Every
// room permission rule lives in this package.
//
// Rooms come in two kinds:
//   - restricted: permanent; the owner keeps a member list. Ownership can be
//     transferred, after which the old owner may leave.
//   - private: temporary; anyone with the join code becomes a member. It is
//     deleted after being empty for a grace period. Its owner cannot leave
//     (deleting the room is the way out).
//
// Callers that are not members get room_not_found, so room ids do not leak.
// Admins can see and manage every room.
package rooms

import (
	"context"
	"crypto/rand"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"p2p-share-screen/backend/internal/apperr"
	"p2p-share-screen/backend/internal/id"
	"p2p-share-screen/backend/internal/store"
)

const (
	maxNameRunes = 64
	// 32 symbols without 0/1/I/O, so codes are easy to read aloud.
	codeAlphabet    = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
	codeLen         = 8
	maxCodeAttempts = 5
)

// DefaultEmptyGrace is how long a private room may stay empty before it is
// deleted, so a brief disconnect does not end it.
const DefaultEmptyGrace = 5 * time.Minute

var (
	errRoomNotFound      = apperr.NotFound("room_not_found", "room not found")
	errNotOwner          = apperr.Forbidden("not_room_owner", "only the room owner can do this")
	errInvalidName       = apperr.Invalid("invalid_room_name", "room name must have 1 to 64 characters")
	errInvalidType       = apperr.Invalid("invalid_room_type", "room type must be 'restricted' or 'private'")
	errInvalidCode       = apperr.NotFound("invalid_join_code", "no room matches this code")
	errNotPrivate        = apperr.Invalid("not_private_room", "only private rooms have a join code")
	errNotRestricted     = apperr.Invalid("not_restricted_room", "ownership can only be transferred in restricted rooms")
	errUserNotFound      = apperr.NotFound("user_not_found", "user not found")
	errUserDisabled      = apperr.Invalid("user_disabled", "user is disabled")
	errMemberNotFound    = apperr.NotFound("member_not_found", "user is not a member of this room")
	errAlreadyMember     = apperr.Conflict("already_member", "user is already a member of this room")
	errOwnerPermissions  = apperr.Invalid("cannot_modify_owner", "the owner's permissions cannot be changed")
	errOwnerMustTransfer = apperr.Invalid("owner_must_transfer", "transfer ownership to another member before leaving")
	errOwnerCannotLeave  = apperr.Invalid("owner_cannot_leave", "the owner of a private room cannot leave; delete the room instead")
)

type Service struct {
	store      *store.Store
	emptyGrace time.Duration
	now        func() time.Time
}

func NewService(st *store.Store, emptyGrace time.Duration) *Service {
	return &Service{store: st, emptyGrace: emptyGrace, now: time.Now}
}

// CanManage reports whether actor may change the room and its members.
func CanManage(actor store.User, l store.RoomListing) bool {
	return actor.Role == store.RoleAdmin || l.MyRole == store.MemberOwner
}

// CanPublish reports whether actor may share their screen in the room.
func CanPublish(actor store.User, l store.RoomListing) bool {
	return CanManage(actor, l) || (l.MyRole == store.MemberMember && l.MyCanPublish)
}

// FormatCode renders a normalized join code as XXXX-XXXX.
func FormatCode(code string) string {
	if len(code) != codeLen {
		return code
	}
	return code[:4] + "-" + code[4:]
}

func (s *Service) List(ctx context.Context, actor store.User) ([]store.RoomListing, error) {
	return s.store.ListRooms(ctx, actor.ID, actor.Role == store.RoleAdmin)
}

func (s *Service) Get(ctx context.Context, actor store.User, roomID string) (store.RoomListing, error) {
	l, err := s.store.GetRoomListing(ctx, roomID, actor.ID)
	if errors.Is(err, store.ErrNotFound) {
		return store.RoomListing{}, errRoomNotFound
	}
	if err != nil {
		return store.RoomListing{}, err
	}
	if l.MyRole == "" && actor.Role != store.RoleAdmin {
		return store.RoomListing{}, errRoomNotFound
	}
	return l, nil
}

type CreateInput struct {
	Name string
	Type store.RoomType
}

// Create makes a room owned by actor.
func (s *Service) Create(ctx context.Context, actor store.User, in CreateInput) (store.RoomListing, error) {
	name, err := normalizeName(in.Name)
	if err != nil {
		return store.RoomListing{}, err
	}
	if !in.Type.Valid() {
		return store.RoomListing{}, errInvalidType
	}
	now := s.now()
	room := store.Room{ID: id.New(), Name: name, Type: in.Type, OwnerID: actor.ID, CreatedAt: now, UpdatedAt: now}
	if room.Type == store.RoomPrivate {
		// Nobody is connected yet; the grace period starts now.
		room.EmptySince = &now
	}
	err = s.store.WithTx(ctx, func(q *store.Queries) error {
		if err := createWithUniqueCode(ctx, q, &room); err != nil {
			return err
		}
		return q.AddRoomMember(ctx, store.RoomMember{
			RoomID: room.ID, UserID: actor.ID, Role: store.MemberOwner, CanPublish: true, JoinedAt: now,
		})
	})
	if err != nil {
		return store.RoomListing{}, err
	}
	return s.store.GetRoomListing(ctx, room.ID, actor.ID)
}

type UpdateInput struct {
	Name *string
}

func (s *Service) Update(ctx context.Context, actor store.User, roomID string, in UpdateInput) (store.RoomListing, error) {
	err := s.store.WithTx(ctx, func(q *store.Queries) error {
		room, err := authorize(ctx, q, actor, roomID, true)
		if err != nil {
			return err
		}
		if in.Name != nil {
			if room.Name, err = normalizeName(*in.Name); err != nil {
				return err
			}
		}
		room.UpdatedAt = s.now()
		return q.UpdateRoom(ctx, room)
	})
	if err != nil {
		return store.RoomListing{}, err
	}
	return s.store.GetRoomListing(ctx, roomID, actor.ID)
}

func (s *Service) Delete(ctx context.Context, actor store.User, roomID string) error {
	return s.store.WithTx(ctx, func(q *store.Queries) error {
		if _, err := authorize(ctx, q, actor, roomID, true); err != nil {
			return err
		}
		return q.DeleteRoom(ctx, roomID)
	})
}

// RegenerateCode replaces a private room's join code. Current members keep
// their access; the old code stops working.
func (s *Service) RegenerateCode(ctx context.Context, actor store.User, roomID string) (store.RoomListing, error) {
	err := s.store.WithTx(ctx, func(q *store.Queries) error {
		room, err := authorize(ctx, q, actor, roomID, true)
		if err != nil {
			return err
		}
		if room.Type != store.RoomPrivate {
			return errNotPrivate
		}
		room.UpdatedAt = s.now()
		for range maxCodeAttempts {
			room.JoinCode = newJoinCode()
			err := q.UpdateRoom(ctx, room)
			if !errors.Is(err, store.ErrConflict) {
				return err
			}
		}
		return errors.New("rooms: could not generate a unique join code")
	})
	if err != nil {
		return store.RoomListing{}, err
	}
	return s.store.GetRoomListing(ctx, roomID, actor.ID)
}

// JoinByCode makes actor a member of the private room with this code.
// Joining a room one is already in is not an error.
func (s *Service) JoinByCode(ctx context.Context, actor store.User, code string) (store.RoomListing, error) {
	normalized := normalizeCode(code)
	if len(normalized) != codeLen {
		return store.RoomListing{}, errInvalidCode
	}
	var roomID string
	err := s.store.WithTx(ctx, func(q *store.Queries) error {
		room, err := q.GetRoomByJoinCode(ctx, normalized)
		if errors.Is(err, store.ErrNotFound) {
			return errInvalidCode
		}
		if err != nil {
			return err
		}
		roomID = room.ID
		err = q.AddRoomMember(ctx, store.RoomMember{
			RoomID: room.ID, UserID: actor.ID, Role: store.MemberMember, CanPublish: true, JoinedAt: s.now(),
		})
		if errors.Is(err, store.ErrConflict) {
			return nil
		}
		return err
	})
	if err != nil {
		return store.RoomListing{}, err
	}
	return s.store.GetRoomListing(ctx, roomID, actor.ID)
}

func (s *Service) ListMembers(ctx context.Context, actor store.User, roomID string) ([]store.MemberListing, error) {
	if _, err := authorize(ctx, s.store.Queries, actor, roomID, false); err != nil {
		return nil, err
	}
	return s.store.ListRoomMembers(ctx, roomID)
}

func (s *Service) AddMember(ctx context.Context, actor store.User, roomID, userID string, canPublish bool) (store.MemberListing, error) {
	var out store.MemberListing
	err := s.store.WithTx(ctx, func(q *store.Queries) error {
		if _, err := authorize(ctx, q, actor, roomID, true); err != nil {
			return err
		}
		u, err := q.GetUserByID(ctx, userID)
		if errors.Is(err, store.ErrNotFound) {
			return errUserNotFound
		}
		if err != nil {
			return err
		}
		if u.Disabled {
			return errUserDisabled
		}
		m := store.RoomMember{RoomID: roomID, UserID: userID, Role: store.MemberMember, CanPublish: canPublish, JoinedAt: s.now()}
		if err := q.AddRoomMember(ctx, m); err != nil {
			if errors.Is(err, store.ErrConflict) {
				return errAlreadyMember
			}
			return err
		}
		out = memberListing(m, u)
		return nil
	})
	return out, err
}

// SetCanPublish changes whether a member may share their screen.
func (s *Service) SetCanPublish(ctx context.Context, actor store.User, roomID, userID string, canPublish bool) (store.MemberListing, error) {
	var out store.MemberListing
	err := s.store.WithTx(ctx, func(q *store.Queries) error {
		if _, err := authorize(ctx, q, actor, roomID, true); err != nil {
			return err
		}
		m, err := q.GetRoomMember(ctx, roomID, userID)
		if errors.Is(err, store.ErrNotFound) {
			return errMemberNotFound
		}
		if err != nil {
			return err
		}
		if m.Role == store.MemberOwner {
			return errOwnerPermissions
		}
		m.CanPublish = canPublish
		if err := q.UpdateRoomMember(ctx, m); err != nil {
			return err
		}
		u, err := q.GetUserByID(ctx, userID)
		if err != nil {
			return err
		}
		out = memberListing(m, u)
		return nil
	})
	return out, err
}

// RemoveMember removes userID from the room. Members may remove themselves
// (leave); removing others requires managing the room.
func (s *Service) RemoveMember(ctx context.Context, actor store.User, roomID, userID string) error {
	return s.store.WithTx(ctx, func(q *store.Queries) error {
		room, err := authorize(ctx, q, actor, roomID, actor.ID != userID)
		if err != nil {
			return err
		}
		m, err := q.GetRoomMember(ctx, roomID, userID)
		if errors.Is(err, store.ErrNotFound) {
			return errMemberNotFound
		}
		if err != nil {
			return err
		}
		if m.Role == store.MemberOwner {
			if room.Type == store.RoomRestricted {
				return errOwnerMustTransfer
			}
			return errOwnerCannotLeave
		}
		return q.DeleteRoomMember(ctx, roomID, userID)
	})
}

// TransferOwnership makes another member the owner of a restricted room.
// The previous owner stays as a member who can publish.
func (s *Service) TransferOwnership(ctx context.Context, actor store.User, roomID, newOwnerID string) (store.RoomListing, error) {
	err := s.store.WithTx(ctx, func(q *store.Queries) error {
		room, err := authorize(ctx, q, actor, roomID, true)
		if err != nil {
			return err
		}
		if room.Type != store.RoomRestricted {
			return errNotRestricted
		}
		if newOwnerID == room.OwnerID {
			return nil
		}
		next, err := q.GetRoomMember(ctx, roomID, newOwnerID)
		if errors.Is(err, store.ErrNotFound) {
			return errMemberNotFound
		}
		if err != nil {
			return err
		}
		u, err := q.GetUserByID(ctx, newOwnerID)
		if err != nil {
			return err
		}
		if u.Disabled {
			return errUserDisabled
		}
		prev, err := q.GetRoomMember(ctx, roomID, room.OwnerID)
		if err != nil {
			return err
		}
		prev.Role, prev.CanPublish = store.MemberMember, true
		next.Role, next.CanPublish = store.MemberOwner, true
		if err := q.UpdateRoomMember(ctx, prev); err != nil {
			return err
		}
		if err := q.UpdateRoomMember(ctx, next); err != nil {
			return err
		}
		room.OwnerID = newOwnerID
		room.UpdatedAt = s.now()
		return q.UpdateRoom(ctx, room)
	})
	if err != nil {
		return store.RoomListing{}, err
	}
	return s.store.GetRoomListing(ctx, roomID, actor.ID)
}

// DeleteExpiredTemporary deletes private rooms that have been empty longer
// than the grace period and returns their ids.
func (s *Service) DeleteExpiredTemporary(ctx context.Context) ([]string, error) {
	return s.store.DeleteEmptyPrivateRooms(ctx, s.now().Add(-s.emptyGrace))
}

// authorize loads the room and checks that actor may view it, or manage it
// when manage is set.
func authorize(ctx context.Context, q *store.Queries, actor store.User, roomID string, manage bool) (store.Room, error) {
	room, err := q.GetRoom(ctx, roomID)
	if errors.Is(err, store.ErrNotFound) {
		return store.Room{}, errRoomNotFound
	}
	if err != nil {
		return store.Room{}, err
	}
	if actor.Role == store.RoleAdmin {
		return room, nil
	}
	m, err := q.GetRoomMember(ctx, roomID, actor.ID)
	if errors.Is(err, store.ErrNotFound) {
		return store.Room{}, errRoomNotFound
	}
	if err != nil {
		return store.Room{}, err
	}
	if manage && m.Role != store.MemberOwner {
		return store.Room{}, errNotOwner
	}
	return room, nil
}

func createWithUniqueCode(ctx context.Context, q *store.Queries, room *store.Room) error {
	if room.Type != store.RoomPrivate {
		return q.CreateRoom(ctx, *room)
	}
	for range maxCodeAttempts {
		room.JoinCode = newJoinCode()
		err := q.CreateRoom(ctx, *room)
		if !errors.Is(err, store.ErrConflict) {
			return err
		}
	}
	return errors.New("rooms: could not generate a unique join code")
}

func newJoinCode() string {
	b := make([]byte, codeLen)
	rand.Read(b)
	for i := range b {
		b[i] = codeAlphabet[b[i]%byte(len(codeAlphabet))]
	}
	return string(b)
}

// normalizeCode uppercases and drops separators, so "k7qf-2mxp" works.
func normalizeCode(code string) string {
	return strings.Map(func(r rune) rune {
		if r == '-' || unicode.IsSpace(r) {
			return -1
		}
		return unicode.ToUpper(r)
	}, code)
}

func normalizeName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > maxNameRunes {
		return "", errInvalidName
	}
	return name, nil
}

func memberListing(m store.RoomMember, u store.User) store.MemberListing {
	return store.MemberListing{RoomMember: m, Username: u.Username, DisplayName: u.DisplayName, Disabled: u.Disabled}
}
