package httpapi

import (
	"net/http"
	"time"

	"p2p-share-screen/backend/internal/rooms"
	"p2p-share-screen/backend/internal/store"
)

type roomOwnerDTO struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
}

type liveDTO struct {
	Participants int `json:"participants"`
	Publishers   int `json:"publishers"`
}

type roomDTO struct {
	// Live is null when the media server could not be reached; only set on
	// list and get.
	Live        *liveDTO       `json:"live,omitempty"`
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Type        store.RoomType `json:"type"`
	Temporary   bool           `json:"temporary"`
	Owner       roomOwnerDTO   `json:"owner"`
	JoinCode    string         `json:"join_code,omitempty"` // owner and admins only
	MyRole      string         `json:"my_role,omitempty"`   // empty for admins who are not members
	CanManage   bool           `json:"can_manage"`
	CanPublish  bool           `json:"can_publish"`
	MemberCount int            `json:"member_count"`
	CreatedAt   time.Time      `json:"created_at"`
	UpdatedAt   time.Time      `json:"updated_at"`
}

func toRoomDTO(actor store.User, l store.RoomListing) roomDTO {
	dto := roomDTO{
		ID:          l.ID,
		Name:        l.Name,
		Type:        l.Type,
		Temporary:   l.Type == store.RoomPrivate,
		Owner:       roomOwnerDTO{ID: l.OwnerID, Username: l.OwnerUsername, DisplayName: l.OwnerDisplayName},
		MyRole:      string(l.MyRole),
		CanManage:   rooms.CanManage(actor, l),
		CanPublish:  rooms.CanPublish(actor, l),
		MemberCount: l.MemberCount,
		CreatedAt:   l.CreatedAt,
		UpdatedAt:   l.UpdatedAt,
	}
	if dto.CanManage {
		dto.JoinCode = rooms.FormatCode(l.JoinCode)
	}
	return dto
}

func toRoomViewDTO(actor store.User, v rooms.View) roomDTO {
	dto := toRoomDTO(actor, v.RoomListing)
	if v.Live != nil {
		dto.Live = &liveDTO{Participants: v.Live.Participants, Publishers: v.Live.Publishers}
	}
	return dto
}

type joinTokenResponse struct {
	LiveKitURL string  `json:"livekit_url"`
	Token      string  `json:"token"`
	Room       roomDTO `json:"room"`
}

type memberDTO struct {
	UserID      string           `json:"user_id"`
	Username    string           `json:"username"`
	DisplayName string           `json:"display_name"`
	Role        store.MemberRole `json:"role"`
	CanPublish  bool             `json:"can_publish"`
	Disabled    bool             `json:"disabled"`
	JoinedAt    time.Time        `json:"joined_at"`
}

func toMemberDTO(m store.MemberListing) memberDTO {
	return memberDTO{
		UserID:      m.UserID,
		Username:    m.Username,
		DisplayName: m.DisplayName,
		Role:        m.Role,
		CanPublish:  m.CanPublish,
		Disabled:    m.Disabled,
		JoinedAt:    m.JoinedAt,
	}
}

type createRoomRequest struct {
	Name string         `json:"name"`
	Type store.RoomType `json:"type"`
}

type updateRoomRequest struct {
	Name *string `json:"name"`
}

type joinByCodeRequest struct {
	Code string `json:"code"`
}

type addMemberRequest struct {
	Username   string `json:"username"`
	CanPublish *bool  `json:"can_publish"` // defaults to true
}

type updateMemberRequest struct {
	CanPublish bool `json:"can_publish"`
}

type transferOwnerRequest struct {
	UserID string `json:"user_id"`
}

func (s *Server) handleListRooms(w http.ResponseWriter, r *http.Request, actor store.User) {
	list, err := s.rooms.List(r.Context(), actor)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	out := make([]roomDTO, 0, len(list))
	for _, l := range list {
		out = append(out, toRoomViewDTO(actor, l))
	}
	writeJSON(w, http.StatusOK, map[string]any{"rooms": out})
}

func (s *Server) handleCreateRoom(w http.ResponseWriter, r *http.Request, actor store.User) {
	var req createRoomRequest
	if err := decodeJSON(w, r, &req); err != nil {
		s.writeError(w, r, err)
		return
	}
	l, err := s.rooms.Create(r.Context(), actor, rooms.CreateInput{Name: req.Name, Type: req.Type})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, toRoomDTO(actor, l))
}

func (s *Server) handleGetRoom(w http.ResponseWriter, r *http.Request, actor store.User) {
	l, err := s.rooms.Get(r.Context(), actor, r.PathValue("id"))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toRoomViewDTO(actor, l))
}

func (s *Server) handleUpdateRoom(w http.ResponseWriter, r *http.Request, actor store.User) {
	var req updateRoomRequest
	if err := decodeJSON(w, r, &req); err != nil {
		s.writeError(w, r, err)
		return
	}
	l, err := s.rooms.Update(r.Context(), actor, r.PathValue("id"), rooms.UpdateInput{Name: req.Name})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toRoomDTO(actor, l))
}

func (s *Server) handleDeleteRoom(w http.ResponseWriter, r *http.Request, actor store.User) {
	if err := s.rooms.Delete(r.Context(), actor, r.PathValue("id")); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRegenerateCode(w http.ResponseWriter, r *http.Request, actor store.User) {
	l, err := s.rooms.RegenerateCode(r.Context(), actor, r.PathValue("id"))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toRoomDTO(actor, l))
}

func (s *Server) handleJoinByCode(w http.ResponseWriter, r *http.Request, actor store.User) {
	if !s.codeLimiter.allow(actor.ID) {
		s.writeError(w, r, errTooManyRequests)
		return
	}
	var req joinByCodeRequest
	if err := decodeJSON(w, r, &req); err != nil {
		s.writeError(w, r, err)
		return
	}
	l, err := s.rooms.JoinByCode(r.Context(), actor, req.Code)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toRoomDTO(actor, l))
}

func (s *Server) handleTransferOwner(w http.ResponseWriter, r *http.Request, actor store.User) {
	var req transferOwnerRequest
	if err := decodeJSON(w, r, &req); err != nil {
		s.writeError(w, r, err)
		return
	}
	l, err := s.rooms.TransferOwnership(r.Context(), actor, r.PathValue("id"), req.UserID)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toRoomDTO(actor, l))
}

func (s *Server) handleListMembers(w http.ResponseWriter, r *http.Request, actor store.User) {
	list, err := s.rooms.ListMembers(r.Context(), actor, r.PathValue("id"))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	out := make([]memberDTO, 0, len(list))
	for _, m := range list {
		out = append(out, toMemberDTO(m))
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": out})
}

func (s *Server) handleAddMember(w http.ResponseWriter, r *http.Request, actor store.User) {
	var req addMemberRequest
	if err := decodeJSON(w, r, &req); err != nil {
		s.writeError(w, r, err)
		return
	}
	canPublish := req.CanPublish == nil || *req.CanPublish
	m, err := s.rooms.AddMember(r.Context(), actor, r.PathValue("id"), req.Username, canPublish)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, toMemberDTO(m))
}

func (s *Server) handleUpdateMember(w http.ResponseWriter, r *http.Request, actor store.User) {
	var req updateMemberRequest
	if err := decodeJSON(w, r, &req); err != nil {
		s.writeError(w, r, err)
		return
	}
	m, err := s.rooms.SetCanPublish(r.Context(), actor, r.PathValue("id"), r.PathValue("uid"), req.CanPublish)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toMemberDTO(m))
}

func (s *Server) handleRemoveMember(w http.ResponseWriter, r *http.Request, actor store.User) {
	if err := s.rooms.RemoveMember(r.Context(), actor, r.PathValue("id"), r.PathValue("uid")); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleJoinToken(w http.ResponseWriter, r *http.Request, actor store.User) {
	info, err := s.rooms.Join(r.Context(), actor, r.PathValue("id"))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, joinTokenResponse{
		LiveKitURL: info.URL,
		Token:      info.Token,
		Room:       toRoomDTO(actor, info.Room),
	})
}

func (s *Server) handleLiveKitWebhook(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	ev, err := s.webhooks.ReceiveWebhook(r)
	if err != nil {
		s.log.WarnContext(r.Context(), "rejected livekit webhook", "err", err, "ip", s.clientIP(r))
		s.writeError(w, r, errInvalidWebhook)
		return
	}
	if err := s.rooms.HandleMediaEvent(r.Context(), ev); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
