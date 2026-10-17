// Package config loads settings from environment variables.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	Addr       string
	DBPath     string
	JWTSecret  []byte
	AccessTTL  time.Duration
	RefreshTTL time.Duration
	// TrustProxy makes the client IP come from X-Forwarded-For. Enable only
	// behind a reverse proxy that overwrites that header.
	TrustProxy bool
	// TempRoomGrace is how long a private (temporary) room may stay empty
	// before it is deleted.
	TempRoomGrace time.Duration
}

func Load() (Config, error) {
	cfg := Config{
		Addr:      env("APP_ADDR", ":8080"),
		DBPath:    env("APP_DB_PATH", "./data/app.db"),
		JWTSecret: []byte(os.Getenv("APP_JWT_SECRET")),
	}
	var err error
	if cfg.AccessTTL, err = envDuration("APP_ACCESS_TTL", 15*time.Minute); err != nil {
		return Config{}, err
	}
	if cfg.RefreshTTL, err = envDuration("APP_REFRESH_TTL", 30*24*time.Hour); err != nil {
		return Config{}, err
	}
	if cfg.TempRoomGrace, err = envDuration("APP_TEMP_ROOM_GRACE", 5*time.Minute); err != nil {
		return Config{}, err
	}
	if cfg.TrustProxy, err = envBool("APP_TRUST_PROXY", false); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// ValidateServe checks the settings that only the HTTP server needs, so CLI
// subcommands can run without them.
func (c Config) ValidateServe() error {
	if len(c.JWTSecret) < 32 {
		return errors.New("APP_JWT_SECRET must be set and at least 32 bytes long")
	}
	return nil
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envDuration(key string, def time.Duration) (time.Duration, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		return 0, fmt.Errorf("%s: invalid duration %q", key, v)
	}
	return d, nil
}

func envBool(key string, def bool) (bool, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return false, fmt.Errorf("%s: invalid boolean %q", key, v)
	}
	return b, nil
}
