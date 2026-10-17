// Command server runs the p2p-share-screen API.
//
//	server [serve]                                     start the HTTP API
//	server admin create --username X [--display-name Y]  create an admin
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"

	"p2p-share-screen/backend/internal/auth"
	"p2p-share-screen/backend/internal/config"
	"p2p-share-screen/backend/internal/httpapi"
	"p2p-share-screen/backend/internal/store"
	"p2p-share-screen/backend/internal/users"
)

const usage = `usage:
  server [serve]
  server admin create --username NAME [--display-name NAME]`

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(context.Background(), os.Args[1:], logger); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, logger *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	switch {
	case len(args) == 0 || args[0] == "serve":
		return serve(ctx, cfg, logger)
	case len(args) >= 2 && args[0] == "admin" && args[1] == "create":
		return adminCreate(ctx, cfg, args[2:])
	default:
		return errors.New(usage)
	}
}

func serve(ctx context.Context, cfg config.Config, logger *slog.Logger) error {
	if err := cfg.ValidateServe(); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.Open(ctx, cfg.DBPath)
	if err != nil {
		return err
	}
	defer st.Close()

	hasher := auth.NewPasswordHasher(auth.DefaultPasswordParams)
	authSvc := auth.NewService(st, hasher, auth.Config{
		JWTSecret:  cfg.JWTSecret,
		AccessTTL:  cfg.AccessTTL,
		RefreshTTL: cfg.RefreshTTL,
	})
	api := httpapi.New(httpapi.Deps{
		Store:      st,
		Auth:       authSvc,
		Users:      users.NewService(st, hasher),
		Logger:     logger,
		TrustProxy: cfg.TrustProxy,
	})

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           api,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}

	go cleanupLoop(ctx, authSvc, logger)

	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()
	logger.Info("listening", "addr", cfg.Addr)

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}
	logger.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}

func cleanupLoop(ctx context.Context, authSvc *auth.Service, logger *slog.Logger) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			n, err := authSvc.CleanupExpired(ctx)
			if err != nil {
				logger.Error("cleanup expired refresh tokens", "err", err)
				continue
			}
			if n > 0 {
				logger.Info("deleted expired refresh tokens", "count", n)
			}
		}
	}
}

func adminCreate(ctx context.Context, cfg config.Config, args []string) error {
	fs := flag.NewFlagSet("admin create", flag.ContinueOnError)
	username := fs.String("username", "", "admin username (required)")
	displayName := fs.String("display-name", "", "display name (defaults to the username)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *username == "" {
		return errors.New("--username is required")
	}
	password, err := readPassword()
	if err != nil {
		return err
	}

	st, err := store.Open(ctx, cfg.DBPath)
	if err != nil {
		return err
	}
	defer st.Close()

	u, err := users.NewService(st, auth.NewPasswordHasher(auth.DefaultPasswordParams)).Create(ctx, users.CreateInput{
		Username:    *username,
		DisplayName: *displayName,
		Password:    password,
		Role:        store.RoleAdmin,
	})
	if err != nil {
		return err
	}
	fmt.Printf("admin %q created (id %s)\n", u.Username, u.ID)
	return nil
}

// readPassword prompts twice on a terminal, or reads one line from stdin
// when piped (for scripts).
func readPassword() (string, error) {
	fd := int(os.Stdin.Fd())
	if !term.IsTerminal(fd) {
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return "", err
		}
		return strings.TrimRight(line, "\r\n"), nil
	}
	fmt.Fprint(os.Stderr, "Password: ")
	first, err := term.ReadPassword(fd)
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", err
	}
	fmt.Fprint(os.Stderr, "Confirm password: ")
	second, err := term.ReadPassword(fd)
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", err
	}
	if string(first) != string(second) {
		return "", errors.New("passwords do not match")
	}
	return string(first), nil
}
