// Package livekit implements rooms.Media on top of a LiveKit server: it
// issues join tokens, calls the RoomService API and verifies webhooks.
package livekit

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/livekit/protocol/auth"
	lkpb "github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"
	"github.com/twitchtv/twirp"

	"p2p-share-screen/backend/internal/rooms"
)

// Participants may only publish screen shares (video and system audio).
var shareSources = []lkpb.TrackSource{lkpb.TrackSource_SCREEN_SHARE, lkpb.TrackSource_SCREEN_SHARE_AUDIO}

type Config struct {
	// URL is the ws(s):// address clients connect to.
	URL string
	// APIURL is the http(s):// address the backend calls. Defaults to URL
	// with the scheme swapped.
	APIURL    string
	APIKey    string
	APISecret string
	// TokenTTL bounds how long a join token can be used to connect. Once
	// connected, LiveKit refreshes the token itself.
	TokenTTL time.Duration
}

type Client struct {
	cfg   Config
	rooms lkpb.RoomService
	keys  auth.KeyProvider
}

var _ rooms.Media = (*Client)(nil)

func New(cfg Config) *Client {
	if cfg.APIURL == "" {
		cfg.APIURL = httpURL(cfg.URL)
	}
	return &Client{
		cfg:   cfg,
		rooms: lkpb.NewRoomServiceProtobufClient(cfg.APIURL, &http.Client{Timeout: 5 * time.Second}),
		keys:  auth.NewSimpleKeyProvider(cfg.APIKey, cfg.APISecret),
	}
}

func (c *Client) URL() string { return c.cfg.URL }

func (c *Client) JoinToken(roomID, userID, displayName string, canPublish bool) (string, error) {
	grant := &auth.VideoGrant{RoomJoin: true, Room: roomID}
	grant.SetCanSubscribe(true)
	grant.SetCanPublish(canPublish)
	grant.SetCanPublishData(true)
	grant.SetCanUpdateOwnMetadata(false)
	grant.SetCanPublishSources(shareSources)
	return auth.NewAccessToken(c.cfg.APIKey, c.cfg.APISecret).
		SetVideoGrant(grant).
		SetIdentity(userID).
		SetName(displayName).
		SetValidFor(c.cfg.TokenTTL).
		ToJWT()
}

func (c *Client) ListActive(ctx context.Context, roomIDs []string) (map[string]rooms.Activity, error) {
	ctx, err := c.adminContext(ctx, "")
	if err != nil {
		return nil, err
	}
	res, err := c.rooms.ListRooms(ctx, &lkpb.ListRoomsRequest{Names: roomIDs})
	if err != nil {
		return nil, fmt.Errorf("livekit ListRooms: %w", err)
	}
	out := make(map[string]rooms.Activity, len(res.Rooms))
	for _, r := range res.Rooms {
		out[r.Name] = rooms.Activity{Participants: int(r.NumParticipants), Publishers: int(r.NumPublishers)}
	}
	return out, nil
}

func (c *Client) RemoveParticipant(ctx context.Context, roomID, userID string) error {
	ctx, err := c.adminContext(ctx, roomID)
	if err != nil {
		return err
	}
	_, err = c.rooms.RemoveParticipant(ctx, &lkpb.RoomParticipantIdentity{Room: roomID, Identity: userID})
	return ignoreNotFound(err)
}

func (c *Client) SetCanPublish(ctx context.Context, roomID, userID string, canPublish bool) error {
	ctx, err := c.adminContext(ctx, roomID)
	if err != nil {
		return err
	}
	_, err = c.rooms.UpdateParticipant(ctx, &lkpb.UpdateParticipantRequest{
		Room:     roomID,
		Identity: userID,
		Permission: &lkpb.ParticipantPermission{
			CanSubscribe:      true,
			CanPublish:        canPublish,
			CanPublishData:    true,
			CanPublishSources: shareSources,
		},
	})
	return ignoreNotFound(err)
}

func (c *Client) DeleteRoom(ctx context.Context, roomID string) error {
	ctx, err := c.adminContext(ctx, roomID)
	if err != nil {
		return err
	}
	_, err = c.rooms.DeleteRoom(ctx, &lkpb.DeleteRoomRequest{Room: roomID})
	return ignoreNotFound(err)
}

// ReceiveWebhook verifies a LiveKit webhook request (signature and body
// checksum) and maps it to a rooms.MediaEvent.
func (c *Client) ReceiveWebhook(r *http.Request) (rooms.MediaEvent, error) {
	ev, err := webhook.ReceiveWebhookEvent(r, c.keys)
	if err != nil {
		return rooms.MediaEvent{}, err
	}
	out := rooms.MediaEvent{RoomID: ev.GetRoom().GetName()}
	switch ev.Event {
	case webhook.EventRoomStarted, webhook.EventParticipantJoined:
		out.Kind = rooms.MediaRoomOccupied
	case webhook.EventRoomFinished:
		out.Kind = rooms.MediaRoomEmpty
	}
	return out, nil
}

// adminContext attaches a short-lived server API token to ctx.
func (c *Client) adminContext(ctx context.Context, roomID string) (context.Context, error) {
	grant := &auth.VideoGrant{RoomAdmin: true, RoomList: true, RoomCreate: true, Room: roomID}
	token, err := auth.NewAccessToken(c.cfg.APIKey, c.cfg.APISecret).
		SetVideoGrant(grant).
		SetValidFor(time.Minute).
		ToJWT()
	if err != nil {
		return nil, err
	}
	h := http.Header{}
	h.Set("Authorization", "Bearer "+token)
	return twirp.WithHTTPRequestHeaders(ctx, h)
}

func ignoreNotFound(err error) error {
	var terr twirp.Error
	if errors.As(err, &terr) && terr.Code() == twirp.NotFound {
		return nil
	}
	return err
}

func httpURL(u string) string {
	switch {
	case strings.HasPrefix(u, "wss://"):
		return "https://" + strings.TrimPrefix(u, "wss://")
	case strings.HasPrefix(u, "ws://"):
		return "http://" + strings.TrimPrefix(u, "ws://")
	default:
		return u
	}
}
