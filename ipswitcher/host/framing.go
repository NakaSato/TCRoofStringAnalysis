package main

import (
	"encoding/binary"
	"errors"
	"io"
)

const (
	maxRequest = 16 * 1024
	maxReply   = 1024 * 1024
)

var errTooLarge = errors.New("request too large")

// readFrame reads one length-prefixed message. An oversized message is drained and errTooLarge
// returned, so the stream stays in sync. io.EOF at a frame boundary means the browser hung up.
func readFrame(r io.Reader) ([]byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, io.EOF
		}
		return nil, err
	}
	n := binary.LittleEndian.Uint32(hdr[:])
	if n > maxRequest {
		if _, err := io.CopyN(io.Discard, r, int64(n)); err != nil {
			return nil, io.EOF
		}
		return nil, errTooLarge
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, io.EOF
	}
	return buf, nil
}

func writeFrame(w io.Writer, msg []byte) error {
	var hdr [4]byte
	binary.LittleEndian.PutUint32(hdr[:], uint32(len(msg)))
	if _, err := w.Write(append(hdr[:], msg...)); err != nil {
		return err
	}
	return nil
}

// serve answers framed requests until EOF.
func (h *host) serve(r io.Reader, w io.Writer) error {
	for {
		msg, err := readFrame(r)
		var reply []byte
		switch {
		case errors.Is(err, errTooLarge):
			reply = errorReply("", herr("too_large", "The request is larger than 16 KB.", nil))
		case err == io.EOF:
			return nil
		case err != nil:
			return err
		default:
			reply = h.handle(msg)
		}
		if err := writeFrame(w, reply); err != nil {
			return err
		}
	}
}
