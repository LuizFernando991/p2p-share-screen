package rooms

import "context"

// Media is the live media server (LiveKit). Room ids double as media room
// names and user ids as participant identities.
type Media interface {
	// URL is the address clients connect to.
	URL() string
	JoinToken(roomID, userID, displayName string, canPublish bool) (string, error)
	// ListActive returns the activity of the given rooms that are live;
	// rooms missing from the map have nobody connected.
	ListActive(ctx context.Context, roomIDs []string) (map[string]Activity, error)
	// The calls below succeed when the room or participant is not connected.
	RemoveParticipant(ctx context.Context, roomID, userID string) error
	SetCanPublish(ctx context.Context, roomID, userID string, canPublish bool) error
	DeleteRoom(ctx context.Context, roomID string) error
}

// Activity is who is connected to a room right now.
type Activity struct {
	Participants int
	// Publishers are participants sharing their screen.
	Publishers int
}

type MediaEventKind int

const (
	MediaEventIgnored MediaEventKind = iota
	// MediaRoomOccupied: someone connected.
	MediaRoomOccupied
	// MediaRoomEmpty: the media room closed because everyone left.
	MediaRoomEmpty
)

// MediaEvent is a webhook from the media server, reduced to what rooms need.
type MediaEvent struct {
	Kind   MediaEventKind
	RoomID string
}
