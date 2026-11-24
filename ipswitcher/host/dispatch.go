package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"time"
)

const protocolVersion = 1

type request struct {
	ID   string          `json:"id"`
	V    int             `json:"v"`
	Cmd  string          `json:"cmd"`
	Args json.RawMessage `json:"args"`
}

type replyOK struct {
	ID   string `json:"id"`
	OK   bool   `json:"ok"`
	Data any    `json:"data"`
}

type replyErr struct {
	ID    string   `json:"id"`
	OK    bool     `json:"ok"`
	Error errorObj `json:"error"`
}

type errorObj struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Detail  any    `json:"detail,omitempty"`
}

func errorReply(id string, e *hostError) []byte {
	b, err := json.Marshal(replyErr{ID: id, Error: errorObj{Code: e.Code, Message: e.Message, Detail: e.Detail}})
	if err != nil {
		b, _ = json.Marshal(replyErr{ID: id, Error: errorObj{Code: "internal", Message: "Could not encode the error."}})
	}
	return b
}

// decodeStrict decodes exactly one JSON value into v, rejecting unknown fields and trailing data.
func decodeStrict(b []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if _, err := dec.Token(); err != io.EOF {
		return errors.New("unexpected data after the JSON value")
	}
	return nil
}

// decodeArgs decodes args strictly; absent or null args leave v at its zero value.
func decodeArgs(raw json.RawMessage, v any) *hostError {
	if len(raw) == 0 || string(bytes.TrimSpace(raw)) == "null" {
		return nil
	}
	if err := decodeStrict(raw, v); err != nil {
		return herr("bad_request", "Bad args: "+err.Error(), nil)
	}
	return nil
}

type noArgs struct{}

// handle answers one request message.
func (h *host) handle(msg []byte) []byte {
	var req request
	if err := decodeStrict(msg, &req); err != nil {
		var loose struct {
			ID any `json:"id"`
		}
		_ = json.NewDecoder(bytes.NewReader(msg)).Decode(&loose) // first value only, for the id
		id, _ := loose.ID.(string)
		return errorReply(id, herr("bad_request", "Bad request: "+err.Error(), nil))
	}
	if req.V != protocolVersion {
		return errorReply(req.ID, herr("protocol", fmt.Sprintf("This helper speaks protocol %d; the request used %d.", protocolVersion, req.V),
			map[string]any{"protocol": protocolVersion, "hostVersion": version}))
	}
	data, e := h.dispatch(req.Cmd, req.Args)
	if e != nil {
		return errorReply(req.ID, e)
	}
	b, err := json.Marshal(replyOK{ID: req.ID, OK: true, Data: data})
	if err != nil {
		return errorReply(req.ID, herr("internal", "Could not encode the reply: "+err.Error(), nil))
	}
	if len(b) > maxReply {
		return errorReply(req.ID, herr("internal", "The reply is larger than 1 MB.", nil))
	}
	return b
}

func (h *host) dispatch(cmd string, raw json.RawMessage) (any, *hostError) {
	switch cmd {
	case "health":
		var a noArgs
		if e := decodeArgs(raw, &a); e != nil {
			return nil, e
		}
		ok, err := h.sys.canWrite()
		if err != nil {
			ok = false
		}
		return map[string]any{"hostVersion": version, "protocol": protocolVersion, "user": h.user, "canWrite": ok}, nil
	case "listAdapters":
		var a struct {
			ShowAll bool `json:"showAll"`
		}
		if e := decodeArgs(raw, &a); e != nil {
			return nil, e
		}
		list, err := h.inventory(a.ShowAll)
		if err != nil {
			return nil, sysError(err)
		}
		return list, nil
	case "apply":
		var a applyArgs
		if len(raw) == 0 {
			return nil, herr("bad_request", "apply needs args", nil)
		}
		if e := decodeArgs(raw, &a); e != nil {
			return nil, e
		}
		return h.apply(a)
	case "confirm":
		var a noArgs
		if e := decodeArgs(raw, &a); e != nil {
			return nil, e
		}
		return h.confirm()
	case "revert":
		var a noArgs
		if e := decodeArgs(raw, &a); e != nil {
			return nil, e
		}
		ad, e := h.revert()
		if e != nil {
			return nil, e
		}
		return map[string]any{"adapter": ad}, nil
	case "pending":
		var a noArgs
		if e := decodeArgs(raw, &a); e != nil {
			return nil, e
		}
		pf, err := h.readPending()
		if err != nil {
			return nil, herr("internal", "Could not read pending.json: "+err.Error(), nil)
		}
		if pf == nil {
			return nil, nil
		}
		return pf.Pending, nil
	case "status":
		var a noArgs
		if e := decodeArgs(raw, &a); e != nil {
			return nil, e
		}
		pf, err := h.readPending()
		if err != nil {
			return nil, herr("internal", "Could not read pending.json: "+err.Error(), nil)
		}
		var p *Pending
		if pf != nil {
			p = &pf.Pending
		}
		st, _ := h.loadStatics()
		return map[string]any{"pending": p, "statics": st}, nil
	case "ping":
		var a struct {
			Host *string `json:"host"`
			Once bool    `json:"once"` // one try (ping console), else up to 2
		}
		if e := decodeArgs(raw, &a); e != nil {
			return nil, e
		}
		if a.Host == nil {
			return nil, herr("invalid", "Enter a host to ping.", []fieldError{{Field: "host", Message: "Enter a host to ping"}})
		}
		addr, msg := testHostProblem(*a.Host)
		if msg != "" {
			return nil, herr("invalid", msg, []fieldError{{Field: "host", Message: msg}})
		}
		if a.Once {
			ok, rtt, err := h.sys.ping(addr, time.Second)
			t := Test{Host: addr.String(), Tries: 1}
			if err == nil && ok {
				t.OK, t.RttMs = true, rtt
			}
			return t, nil
		}
		return h.pingTest(addr), nil
	case "log":
		var a struct {
			Limit *int `json:"limit"`
		}
		if e := decodeArgs(raw, &a); e != nil {
			return nil, e
		}
		limit := 100
		if a.Limit != nil {
			if *a.Limit < 1 || *a.Limit > 500 {
				return nil, herr("invalid", "limit must be 1–500", []fieldError{{Field: "limit", Message: "limit must be 1–500"}})
			}
			limit = *a.Limit
		}
		return h.readAudit(limit), nil
	case "":
		return nil, herr("bad_request", "The request has no cmd.", nil)
	}
	return nil, herr("unknown_cmd", fmt.Sprintf("Unknown command %q.", cmd), nil)
}

// pingTest pings up to 2 times with a 1 s timeout, stopping at the first reply.
func (h *host) pingTest(addr netip.Addr) Test {
	t := Test{Host: addr.String()}
	for t.Tries < 2 {
		t.Tries++
		ok, rtt, err := h.sys.ping(addr, time.Second)
		if err == nil && ok {
			t.OK, t.RttMs = true, rtt
			break
		}
	}
	return t
}

// sysError maps a system failure to a protocol error.
func sysError(err error) *hostError {
	var he *hostError
	if errors.As(err, &he) {
		return he
	}
	if errors.Is(err, errTimeout) {
		return herr("timeout", "Windows did not answer within 30 seconds.", err.Error())
	}
	return herr("internal", "Could not read the network adapters: "+err.Error(), nil)
}
