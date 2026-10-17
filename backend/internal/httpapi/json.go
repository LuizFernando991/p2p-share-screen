package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"p2p-share-screen/backend/internal/apperr"
)

const maxBodyBytes = 1 << 20

type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return apperr.Invalid("invalid_body", "request body must be valid JSON: "+err.Error())
	}
	if dec.More() {
		return apperr.Invalid("invalid_body", "request body must contain a single JSON object")
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeError renders domain errors with their code; anything else is logged
// and hidden behind a generic 500.
func (s *Server) writeError(w http.ResponseWriter, r *http.Request, err error) {
	var ae *apperr.Error
	if errors.As(err, &ae) {
		if ae.Kind == apperr.KindUnauthorized {
			w.Header().Set("WWW-Authenticate", "Bearer")
		}
		writeJSON(w, statusFor(ae.Kind), errorBody{errorDetail{ae.Code, ae.Message}})
		return
	}
	s.log.ErrorContext(r.Context(), "internal error", "err", err, "method", r.Method, "path", r.URL.Path)
	writeJSON(w, http.StatusInternalServerError, errorBody{errorDetail{"internal", "internal server error"}})
}

func statusFor(k apperr.Kind) int {
	switch k {
	case apperr.KindInvalid:
		return http.StatusBadRequest
	case apperr.KindUnauthorized:
		return http.StatusUnauthorized
	case apperr.KindForbidden:
		return http.StatusForbidden
	case apperr.KindNotFound:
		return http.StatusNotFound
	case apperr.KindConflict:
		return http.StatusConflict
	case apperr.KindTooManyRequests:
		return http.StatusTooManyRequests
	default:
		return http.StatusInternalServerError
	}
}
