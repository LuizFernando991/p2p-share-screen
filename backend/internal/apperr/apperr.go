// Package apperr defines domain errors that carry a stable machine-readable
// code. The HTTP layer maps each Kind to a status code.
package apperr

type Kind int

const (
	KindInvalid Kind = iota + 1
	KindUnauthorized
	KindForbidden
	KindNotFound
	KindConflict
	KindTooManyRequests
)

type Error struct {
	Kind    Kind
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func Invalid(code, msg string) *Error      { return &Error{KindInvalid, code, msg} }
func Unauthorized(code, msg string) *Error { return &Error{KindUnauthorized, code, msg} }
func Forbidden(code, msg string) *Error    { return &Error{KindForbidden, code, msg} }
func NotFound(code, msg string) *Error     { return &Error{KindNotFound, code, msg} }
func Conflict(code, msg string) *Error     { return &Error{KindConflict, code, msg} }
func TooManyRequests(code, msg string) *Error {
	return &Error{KindTooManyRequests, code, msg}
}
