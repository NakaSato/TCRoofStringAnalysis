package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"time"
)

// dataDir returns (and creates) the folder for pending.json, statics.json and audit.log.
func dataDir() (string, error) {
	dir := os.Getenv("IPSWITCHER_DATA_DIR")
	if dir == "" {
		if runtime.GOOS == "windows" && os.Getenv("LOCALAPPDATA") != "" {
			dir = filepath.Join(os.Getenv("LOCALAPPDATA"), "IPSwitcher")
		} else {
			base, err := os.UserCacheDir()
			if err != nil {
				return "", err
			}
			dir = filepath.Join(base, "IPSwitcher")
		}
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

func currentUser() string {
	if u, err := user.Current(); err == nil && u.Username != "" {
		return u.Username
	}
	if s := os.Getenv("USERNAME"); s != "" {
		return s
	}
	return os.Getenv("USER")
}

// writeJSONAtomic writes v to a temp file next to path and renames it into place.
func writeJSONAtomic(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.tmp-%d-%d", path, os.Getpid(), time.Now().UnixNano())
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	if err := renameRetry(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

func readJSON(path string, v any) (bool, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := json.Unmarshal(b, v); err != nil {
		return false, err
	}
	return true, nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func (h *host) path(name string) string { return filepath.Join(h.dir, name) }

// loadStatics reads statics.json (missing = empty).
func (h *host) loadStatics() ([]Static, error) {
	var st []Static
	if _, err := readJSON(h.path("statics.json"), &st); err != nil {
		return []Static{}, err
	}
	if st == nil {
		st = []Static{}
	}
	return st, nil
}

func (h *host) saveStatics(st []Static) error {
	if st == nil {
		st = []Static{}
	}
	return writeJSONAtomic(h.path("statics.json"), st)
}

// setStatic replaces the record for guid (rec nil = remove it).
func (h *host) setStatic(guid string, rec *Static) {
	st, _ := h.loadStatics()
	out := st[:0]
	for _, s := range st {
		if s.GUID != guid {
			out = append(out, s)
		}
	}
	if rec != nil {
		out = append(out, *rec)
	}
	_ = h.saveStatics(out)
}

func (h *host) staticFor(guid string) *Static {
	st, _ := h.loadStatics()
	for _, s := range st {
		if s.GUID == guid {
			s := s
			return &s
		}
	}
	return nil
}

// inventory lists adapters, computes isInternet and drops statics.json records that no longer match.
func (h *host) inventory(showAll bool) ([]Adapter, error) {
	list, err := h.sys.listAdapters(showAll)
	if err != nil {
		return nil, err
	}
	if list == nil {
		list = []Adapter{}
	}
	markInternet(list)
	st, _ := h.loadStatics()
	keep := st[:0]
	changed := false
	for _, s := range st {
		drop := false
		for _, a := range list {
			if a.GUID == s.GUID && !configEqual(a.Config, s.Config) {
				drop = true
			}
		}
		if drop {
			changed = true
			continue
		}
		keep = append(keep, s)
	}
	if changed {
		_ = h.saveStatics(keep)
	}
	return list, nil
}

func findAdapter(list []Adapter, guid string, index int) (Adapter, bool) {
	for _, a := range list {
		if guid != "" && a.GUID == guid {
			return a, true
		}
	}
	for _, a := range list {
		if a.Index == index {
			return a, true
		}
	}
	return Adapter{}, false
}

// renameRetry retries a rename briefly: on Windows a rename fails with a sharing violation while
// another process (the watchdog, reading pending.json every second) has the file open.
func renameRetry(from, to string) error {
	var err error
	for i := 0; i < 20; i++ {
		if err = os.Rename(from, to); err == nil || errors.Is(err, os.ErrNotExist) {
			return err
		}
		time.Sleep(25 * time.Millisecond)
	}
	return err
}
