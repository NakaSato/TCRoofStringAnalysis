package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"time"
)

const (
	auditMaxBytes = 1024 * 1024
	auditKeep     = 4 // audit.log.1 … audit.log.4
)

// audit appends one entry to audit.log, rotating at 1 MB. Failures are ignored: the change matters more.
func (h *host) audit(e AuditEntry) {
	if e.Time == "" {
		e.Time = h.now().Local().Format(time.RFC3339)
	}
	if e.User == "" {
		e.User = h.user
	}
	line, err := json.Marshal(e)
	if err != nil {
		return
	}
	line = append(line, '\n')
	p := h.path("audit.log")
	if fi, err := os.Stat(p); err == nil && fi.Size()+int64(len(line)) > auditMaxBytes {
		os.Remove(fmt.Sprintf("%s.%d", p, auditKeep))
		for i := auditKeep - 1; i >= 1; i-- {
			os.Rename(fmt.Sprintf("%s.%d", p, i), fmt.Sprintf("%s.%d", p, i+1))
		}
		os.Rename(p, p+".1")
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	f.Write(line)
}

// readAudit returns up to limit entries, newest first, across audit.log and its rotations.
func (h *host) readAudit(limit int) []json.RawMessage {
	out := []json.RawMessage{}
	p := h.path("audit.log")
	files := []string{p}
	for i := 1; i <= auditKeep; i++ {
		files = append(files, fmt.Sprintf("%s.%d", p, i))
	}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var lines []json.RawMessage
		sc := bufio.NewScanner(bytes.NewReader(b))
		sc.Buffer(make([]byte, 64*1024), auditMaxBytes)
		for sc.Scan() {
			l := bytes.TrimSpace(sc.Bytes())
			if len(l) == 0 || !json.Valid(l) {
				continue
			}
			lines = append(lines, json.RawMessage(append([]byte(nil), l...)))
		}
		for i := len(lines) - 1; i >= 0; i-- {
			out = append(out, lines[i])
			if len(out) >= limit {
				return out
			}
		}
	}
	return out
}
