package httpapi

import (
	"net/http"
	"time"

	"p2p-share-screen/backend/internal/store"
	"p2p-share-screen/backend/internal/users"
)

type userDTO struct {
	ID          string     `json:"id"`
	Username    string     `json:"username"`
	DisplayName string     `json:"display_name"`
	Role        store.Role `json:"role"`
	Disabled    bool       `json:"disabled"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

func toUserDTO(u store.User) userDTO {
	return userDTO{
		ID:          u.ID,
		Username:    u.Username,
		DisplayName: u.DisplayName,
		Role:        u.Role,
		Disabled:    u.Disabled,
		CreatedAt:   u.CreatedAt,
		UpdatedAt:   u.UpdatedAt,
	}
}

type createUserRequest struct {
	Username    string     `json:"username"`
	DisplayName string     `json:"display_name"`
	Password    string     `json:"password"`
	Role        store.Role `json:"role"`
}

type updateUserRequest struct {
	DisplayName *string     `json:"display_name"`
	Role        *store.Role `json:"role"`
	Disabled    *bool       `json:"disabled"`
	Password    *string     `json:"password"`
}

// directoryUserDTO is the public view of a user, visible to everyone.
type directoryUserDTO struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
}

func (s *Server) handleDirectory(w http.ResponseWriter, r *http.Request, _ store.User) {
	list, err := s.users.Directory(r.Context(), r.URL.Query().Get("q"))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	out := make([]directoryUserDTO, 0, len(list))
	for _, u := range list {
		out = append(out, directoryUserDTO{ID: u.ID, Username: u.Username, DisplayName: u.DisplayName})
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": out})
}

func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request, _ store.User) {
	list, err := s.users.List(r.Context())
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	out := make([]userDTO, 0, len(list))
	for _, u := range list {
		out = append(out, toUserDTO(u))
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": out})
}

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request, _ store.User) {
	var req createUserRequest
	if err := decodeJSON(w, r, &req); err != nil {
		s.writeError(w, r, err)
		return
	}
	u, err := s.users.Create(r.Context(), users.CreateInput{
		Username:    req.Username,
		DisplayName: req.DisplayName,
		Password:    req.Password,
		Role:        req.Role,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, toUserDTO(u))
}

func (s *Server) handleGetUser(w http.ResponseWriter, r *http.Request, _ store.User) {
	u, err := s.users.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toUserDTO(u))
}

func (s *Server) handleUpdateUser(w http.ResponseWriter, r *http.Request, actor store.User) {
	var req updateUserRequest
	if err := decodeJSON(w, r, &req); err != nil {
		s.writeError(w, r, err)
		return
	}
	u, err := s.users.Update(r.Context(), actor.ID, r.PathValue("id"), users.UpdateInput{
		DisplayName: req.DisplayName,
		Role:        req.Role,
		Disabled:    req.Disabled,
		Password:    req.Password,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toUserDTO(u))
}

func (s *Server) handleDeleteUser(w http.ResponseWriter, r *http.Request, actor store.User) {
	if err := s.users.Delete(r.Context(), actor.ID, r.PathValue("id")); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
