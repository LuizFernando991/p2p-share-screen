package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"

	"p2p-share-screen/backend/internal/apperr"
)

const (
	minPasswordRunes = 8
	maxPasswordBytes = 256
)

type PasswordParams struct {
	Memory  uint32 // KiB
	Time    uint32
	Threads uint8
	SaltLen uint32
	KeyLen  uint32
}

// DefaultPasswordParams follows the RFC 9106 second recommended option.
var DefaultPasswordParams = PasswordParams{Memory: 64 * 1024, Time: 3, Threads: 2, SaltLen: 16, KeyLen: 32}

// FastPasswordParams makes hashing nearly free. For tests only.
var FastPasswordParams = PasswordParams{Memory: 8, Time: 1, Threads: 1, SaltLen: 16, KeyLen: 32}

var errMalformedHash = errors.New("auth: malformed password hash")

// PasswordHasher hashes passwords with argon2id in PHC string format.
type PasswordHasher struct {
	params PasswordParams
}

func NewPasswordHasher(p PasswordParams) *PasswordHasher {
	return &PasswordHasher{params: p}
}

func (h *PasswordHasher) Hash(password string) (string, error) {
	p := h.params
	salt := make([]byte, p.SaltLen)
	rand.Read(salt)
	key := argon2.IDKey([]byte(password), salt, p.Time, p.Memory, p.Threads, p.KeyLen)
	b64 := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, p.Memory, p.Time, p.Threads,
		b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

// Verify checks password against an encoded hash, using the parameters
// stored in the hash itself.
func (h *PasswordHasher) Verify(password, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errMalformedHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false, errMalformedHash
	}
	var (
		memory, time uint32
		threads      uint8
	)
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &time, &threads); err != nil {
		return false, errMalformedHash
	}
	b64 := base64.RawStdEncoding
	salt, err := b64.DecodeString(parts[4])
	if err != nil {
		return false, errMalformedHash
	}
	key, err := b64.DecodeString(parts[5])
	if err != nil || len(key) == 0 {
		return false, errMalformedHash
	}
	got := argon2.IDKey([]byte(password), salt, time, memory, threads, uint32(len(key)))
	return subtle.ConstantTimeCompare(got, key) == 1, nil
}

// ValidatePassword enforces the password policy for new passwords.
func ValidatePassword(password string) error {
	if utf8.RuneCountInString(password) < minPasswordRunes {
		return apperr.Invalid("weak_password", fmt.Sprintf("password must have at least %d characters", minPasswordRunes))
	}
	if len(password) > maxPasswordBytes {
		return apperr.Invalid("password_too_long", fmt.Sprintf("password must have at most %d bytes", maxPasswordBytes))
	}
	return nil
}
