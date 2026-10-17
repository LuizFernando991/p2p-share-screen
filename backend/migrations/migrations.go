// Package migrations embeds the goose SQL migrations, applied on startup.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
