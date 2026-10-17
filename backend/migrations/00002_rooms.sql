-- +goose Up
-- 'restricted' rooms are permanent and entered by member list.
-- 'private' rooms are temporary, entered by invite code, and deleted once
-- they have been empty (nobody connected) for a grace period.
CREATE TABLE rooms (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('restricted', 'private')),
    owner_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Normalized invite code (no dash); set only for private rooms.
    join_code   TEXT UNIQUE,
    -- When the room last became empty; NULL while someone is connected.
    -- Only used for private rooms.
    empty_since TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    CHECK ((type = 'private') = (join_code IS NOT NULL))
);

CREATE INDEX rooms_owner_id ON rooms (owner_id);
CREATE INDEX rooms_empty_since ON rooms (empty_since) WHERE type = 'private';

-- The owner is also a member (role 'owner'), so "rooms I can enter" is a
-- single lookup in this table.
CREATE TABLE room_members (
    room_id     TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    can_publish INTEGER NOT NULL DEFAULT 1,
    joined_at   TEXT NOT NULL,
    PRIMARY KEY (room_id, user_id)
);

CREATE INDEX room_members_user_id ON room_members (user_id);

-- +goose Down
DROP TABLE room_members;
DROP TABLE rooms;
