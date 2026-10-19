-- +goose Up
-- Every room now has an invite code, not only private ones. SQLite cannot
-- drop the old CHECK, so rooms is rebuilt. Dropping rooms with foreign keys
-- on would cascade into room_members, so the members are set aside first.
CREATE TABLE rooms_new (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('restricted', 'private')),
    owner_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Normalized invite code (no dash).
    join_code   TEXT NOT NULL UNIQUE,
    -- When the room last became empty; NULL while someone is connected.
    -- Only used for private rooms.
    empty_since TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- Restricted rooms get a random code from the same 32-symbol alphabet.
INSERT INTO rooms_new (id, name, type, owner_id, join_code, empty_since, created_at, updated_at)
SELECT id, name, type, owner_id,
       COALESCE(join_code,
           substr('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', (abs(random()) % 32) + 1, 1) ||
           substr('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', (abs(random()) % 32) + 1, 1) ||
           substr('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', (abs(random()) % 32) + 1, 1) ||
           substr('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', (abs(random()) % 32) + 1, 1) ||
           substr('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', (abs(random()) % 32) + 1, 1) ||
           substr('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', (abs(random()) % 32) + 1, 1) ||
           substr('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', (abs(random()) % 32) + 1, 1) ||
           substr('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', (abs(random()) % 32) + 1, 1)),
       empty_since, created_at, updated_at
FROM rooms;

CREATE TABLE room_members_saved AS SELECT * FROM room_members;
DROP TABLE room_members;
DROP TABLE rooms;
ALTER TABLE rooms_new RENAME TO rooms;

CREATE INDEX rooms_owner_id ON rooms (owner_id);
CREATE INDEX rooms_empty_since ON rooms (empty_since) WHERE type = 'private';

CREATE TABLE room_members (
    room_id     TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    can_publish INTEGER NOT NULL DEFAULT 1,
    joined_at   TEXT NOT NULL,
    PRIMARY KEY (room_id, user_id)
);

CREATE INDEX room_members_user_id ON room_members (user_id);

INSERT INTO room_members (room_id, user_id, role, can_publish, joined_at)
SELECT room_id, user_id, role, can_publish, joined_at FROM room_members_saved;
DROP TABLE room_members_saved;

-- +goose Down
CREATE TABLE rooms_old (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('restricted', 'private')),
    owner_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    join_code   TEXT UNIQUE,
    empty_since TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    CHECK ((type = 'private') = (join_code IS NOT NULL))
);

INSERT INTO rooms_old (id, name, type, owner_id, join_code, empty_since, created_at, updated_at)
SELECT id, name, type, owner_id, CASE WHEN type = 'private' THEN join_code END,
       empty_since, created_at, updated_at
FROM rooms;

CREATE TABLE room_members_saved AS SELECT * FROM room_members;
DROP TABLE room_members;
DROP TABLE rooms;
ALTER TABLE rooms_old RENAME TO rooms;

CREATE INDEX rooms_owner_id ON rooms (owner_id);
CREATE INDEX rooms_empty_since ON rooms (empty_since) WHERE type = 'private';

CREATE TABLE room_members (
    room_id     TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    can_publish INTEGER NOT NULL DEFAULT 1,
    joined_at   TEXT NOT NULL,
    PRIMARY KEY (room_id, user_id)
);

CREATE INDEX room_members_user_id ON room_members (user_id);

INSERT INTO room_members (room_id, user_id, role, can_publish, joined_at)
SELECT room_id, user_id, role, can_publish, joined_at FROM room_members_saved;
DROP TABLE room_members_saved;
