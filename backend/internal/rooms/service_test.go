package rooms

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"p2p-share-screen/backend/internal/apperr"
	"p2p-share-screen/backend/internal/auth"
	"p2p-share-screen/backend/internal/store"
	"p2p-share-screen/backend/internal/testutil"
	"p2p-share-screen/backend/internal/users"
)

type fixture struct {
	svc   *Service
	st    *store.Store
	users *users.Service
	admin store.User
	alice store.User // room owner in most tests
	bob   store.User
	carol store.User
}

func setup(t *testing.T) *fixture {
	t.Helper()
	st := testutil.OpenStore(t)
	userSvc := users.NewService(st, auth.NewPasswordHasher(auth.FastPasswordParams))
	mk := func(name string, role store.Role) store.User {
		u, err := userSvc.Create(context.Background(), users.CreateInput{Username: name, Password: "password 1234", Role: role})
		if err != nil {
			t.Fatal(err)
		}
		return u
	}
	return &fixture{
		svc:   NewService(st, DefaultEmptyGrace),
		st:    st,
		users: userSvc,
		admin: mk("admin", store.RoleAdmin),
		alice: mk("alice", store.RoleUser),
		bob:   mk("bob", store.RoleUser),
		carol: mk("carol", store.RoleUser),
	}
}

func (f *fixture) create(t *testing.T, owner store.User, typ store.RoomType) store.RoomListing {
	t.Helper()
	l, err := f.svc.Create(context.Background(), owner, CreateInput{Name: "Room " + string(typ), Type: typ})
	if err != nil {
		t.Fatal(err)
	}
	return l
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var ae *apperr.Error
	if !errors.As(err, &ae) || ae.Code != code {
		t.Fatalf("got error %v, want code %q", err, code)
	}
}

func mustOK(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestCreate(t *testing.T) {
	f := setup(t)
	ctx := context.Background()

	fixed := f.create(t, f.alice, store.RoomRestricted)
	if fixed.MyRole != store.MemberOwner || fixed.MemberCount != 1 || fixed.JoinCode != "" || fixed.EmptySince != nil {
		t.Fatalf("unexpected restricted room: %+v", fixed)
	}

	temp := f.create(t, f.alice, store.RoomPrivate)
	if len(temp.JoinCode) != codeLen || temp.EmptySince == nil {
		t.Fatalf("unexpected private room: %+v", temp)
	}
	if got := FormatCode(temp.JoinCode); len(got) != 9 || got[4] != '-' {
		t.Fatalf("FormatCode = %q", got)
	}

	_, err := f.svc.Create(ctx, f.alice, CreateInput{Name: "  ", Type: store.RoomRestricted})
	wantCode(t, err, "invalid_room_name")
	_, err = f.svc.Create(ctx, f.alice, CreateInput{Name: strings.Repeat("x", 65), Type: store.RoomRestricted})
	wantCode(t, err, "invalid_room_name")
	_, err = f.svc.Create(ctx, f.alice, CreateInput{Name: "x", Type: "public"})
	wantCode(t, err, "invalid_room_type")
}

func TestVisibility(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	room := f.create(t, f.alice, store.RoomRestricted)

	_, err := f.svc.Get(ctx, f.bob, room.ID)
	wantCode(t, err, "room_not_found")
	_, err = f.svc.ListMembers(ctx, f.bob, room.ID)
	wantCode(t, err, "room_not_found")

	if l, err := f.svc.Get(ctx, f.admin, room.ID); err != nil || l.MyRole != "" {
		t.Fatalf("admin get: %+v %v", l, err)
	}

	list, _ := f.svc.List(ctx, f.bob)
	if len(list) != 0 {
		t.Fatalf("bob sees %d rooms, want 0", len(list))
	}
	list, _ = f.svc.List(ctx, f.admin)
	if len(list) != 1 {
		t.Fatalf("admin sees %d rooms, want 1", len(list))
	}

	_, err = f.svc.AddMember(ctx, f.alice, room.ID, f.bob.ID, true)
	mustOK(t, err)
	list, _ = f.svc.List(ctx, f.bob)
	if len(list) != 1 || list[0].MyRole != store.MemberMember {
		t.Fatalf("bob after add: %+v", list)
	}
}

func TestMembersCannotManage(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	room := f.create(t, f.alice, store.RoomRestricted)
	_, err := f.svc.AddMember(ctx, f.alice, room.ID, f.bob.ID, true)
	mustOK(t, err)

	_, err = f.svc.AddMember(ctx, f.bob, room.ID, f.carol.ID, true)
	wantCode(t, err, "not_room_owner")
	_, err = f.svc.Update(ctx, f.bob, room.ID, UpdateInput{Name: new("hacked")})
	wantCode(t, err, "not_room_owner")
	wantCode(t, f.svc.Delete(ctx, f.bob, room.ID), "not_room_owner")
	_, err = f.svc.SetCanPublish(ctx, f.bob, room.ID, f.bob.ID, true)
	wantCode(t, err, "not_room_owner")
	wantCode(t, f.svc.RemoveMember(ctx, f.bob, room.ID, f.alice.ID), "not_room_owner")

	// Admins can manage any room.
	_, err = f.svc.AddMember(ctx, f.admin, room.ID, f.carol.ID, false)
	mustOK(t, err)
}

func TestMemberManagement(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	room := f.create(t, f.alice, store.RoomRestricted)

	m, err := f.svc.AddMember(ctx, f.alice, room.ID, f.bob.ID, false)
	mustOK(t, err)
	if m.Username != "bob" || m.CanPublish {
		t.Fatalf("added member: %+v", m)
	}
	_, err = f.svc.AddMember(ctx, f.alice, room.ID, f.bob.ID, true)
	wantCode(t, err, "already_member")
	_, err = f.svc.AddMember(ctx, f.alice, room.ID, "missing", true)
	wantCode(t, err, "user_not_found")

	l, _ := f.svc.Get(ctx, f.bob, room.ID)
	if CanPublish(f.bob, l) {
		t.Fatal("bob should not be able to publish")
	}
	_, err = f.svc.SetCanPublish(ctx, f.alice, room.ID, f.bob.ID, true)
	mustOK(t, err)
	l, _ = f.svc.Get(ctx, f.bob, room.ID)
	if !CanPublish(f.bob, l) {
		t.Fatal("bob should be able to publish")
	}
	_, err = f.svc.SetCanPublish(ctx, f.alice, room.ID, f.alice.ID, false)
	wantCode(t, err, "cannot_modify_owner")

	members, _ := f.svc.ListMembers(ctx, f.bob, room.ID)
	if len(members) != 2 || members[0].Role != store.MemberOwner {
		t.Fatalf("members: %+v", members)
	}

	// Members can leave by themselves.
	mustOK(t, f.svc.RemoveMember(ctx, f.bob, room.ID, f.bob.ID))
	_, err = f.svc.Get(ctx, f.bob, room.ID)
	wantCode(t, err, "room_not_found")
	wantCode(t, f.svc.RemoveMember(ctx, f.alice, room.ID, f.bob.ID), "member_not_found")

	f.users.Update(ctx, f.admin.ID, f.carol.ID, users.UpdateInput{Disabled: new(true)})
	_, err = f.svc.AddMember(ctx, f.alice, room.ID, f.carol.ID, true)
	wantCode(t, err, "user_disabled")
}

func TestOwnerLeavingAndTransfer(t *testing.T) {
	f := setup(t)
	ctx := context.Background()

	fixed := f.create(t, f.alice, store.RoomRestricted)
	wantCode(t, f.svc.RemoveMember(ctx, f.alice, fixed.ID, f.alice.ID), "owner_must_transfer")

	_, err := f.svc.TransferOwnership(ctx, f.alice, fixed.ID, f.bob.ID)
	wantCode(t, err, "member_not_found")
	_, err = f.svc.AddMember(ctx, f.alice, fixed.ID, f.bob.ID, false)
	mustOK(t, err)
	_, err = f.svc.TransferOwnership(ctx, f.bob, fixed.ID, f.bob.ID)
	wantCode(t, err, "not_room_owner")

	l, err := f.svc.TransferOwnership(ctx, f.alice, fixed.ID, f.bob.ID)
	mustOK(t, err)
	if l.OwnerID != f.bob.ID || l.MyRole != store.MemberMember || !l.MyCanPublish {
		t.Fatalf("after transfer (alice's view): %+v", l)
	}
	if l, _ := f.svc.Get(ctx, f.bob, fixed.ID); l.MyRole != store.MemberOwner || !CanPublish(f.bob, l) {
		t.Fatalf("after transfer (bob's view): %+v", l)
	}
	// The old owner can now leave; the room lives on.
	mustOK(t, f.svc.RemoveMember(ctx, f.alice, fixed.ID, f.alice.ID))
	if _, err := f.svc.Get(ctx, f.bob, fixed.ID); err != nil {
		t.Fatalf("room should survive: %v", err)
	}

	temp := f.create(t, f.alice, store.RoomPrivate)
	wantCode(t, f.svc.RemoveMember(ctx, f.alice, temp.ID, f.alice.ID), "owner_cannot_leave")
	_, err = f.svc.TransferOwnership(ctx, f.alice, temp.ID, f.bob.ID)
	wantCode(t, err, "not_restricted_room")
}

func TestJoinByCode(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	room := f.create(t, f.alice, store.RoomPrivate)

	pretty := strings.ToLower(FormatCode(room.JoinCode))
	l, err := f.svc.JoinByCode(ctx, f.bob, " "+pretty+" ")
	mustOK(t, err)
	if l.ID != room.ID || l.MyRole != store.MemberMember || !CanPublish(f.bob, l) {
		t.Fatalf("join: %+v", l)
	}
	// Joining again is a no-op.
	if l, err := f.svc.JoinByCode(ctx, f.bob, room.JoinCode); err != nil || l.MemberCount != 2 {
		t.Fatalf("rejoin: %+v %v", l, err)
	}
	_, err = f.svc.JoinByCode(ctx, f.carol, "ZZZZ-ZZZZ")
	wantCode(t, err, "invalid_join_code")
	_, err = f.svc.JoinByCode(ctx, f.carol, "short")
	wantCode(t, err, "invalid_join_code")

	// Regenerating kills the old code but keeps members.
	_, err = f.svc.RegenerateCode(ctx, f.bob, room.ID)
	wantCode(t, err, "not_room_owner")
	fresh, err := f.svc.RegenerateCode(ctx, f.alice, room.ID)
	mustOK(t, err)
	if fresh.JoinCode == room.JoinCode {
		t.Fatal("code did not change")
	}
	_, err = f.svc.JoinByCode(ctx, f.carol, room.JoinCode)
	wantCode(t, err, "invalid_join_code")
	if _, err := f.svc.Get(ctx, f.bob, room.ID); err != nil {
		t.Fatalf("bob should keep access: %v", err)
	}

	fixed := f.create(t, f.alice, store.RoomRestricted)
	_, err = f.svc.RegenerateCode(ctx, f.alice, fixed.ID)
	wantCode(t, err, "not_private_room")
}

func TestDeleteExpiredTemporary(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	temp := f.create(t, f.alice, store.RoomPrivate)
	occupied := f.create(t, f.alice, store.RoomPrivate)
	fixed := f.create(t, f.alice, store.RoomRestricted)
	mustOK(t, f.st.SetRoomEmptySince(ctx, occupied.ID, nil))

	if ids, _ := f.svc.DeleteExpiredTemporary(ctx); len(ids) != 0 {
		t.Fatalf("deleted %v within the grace period", ids)
	}

	f.svc.now = func() time.Time { return time.Now().Add(DefaultEmptyGrace + time.Second) }
	ids, err := f.svc.DeleteExpiredTemporary(ctx)
	mustOK(t, err)
	if len(ids) != 1 || ids[0] != temp.ID {
		t.Fatalf("deleted %v, want only %s", ids, temp.ID)
	}
	if _, err := f.svc.Get(ctx, f.alice, occupied.ID); err != nil {
		t.Fatalf("occupied room should survive: %v", err)
	}
	if _, err := f.svc.Get(ctx, f.alice, fixed.ID); err != nil {
		t.Fatalf("restricted room should survive: %v", err)
	}
}

func TestDeletingOwnerDeletesRooms(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	room := f.create(t, f.alice, store.RoomRestricted)
	mustOK(t, f.users.Delete(ctx, f.admin.ID, f.alice.ID))
	_, err := f.svc.Get(ctx, f.admin, room.ID)
	wantCode(t, err, "room_not_found")
}
