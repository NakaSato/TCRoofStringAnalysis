// Command nmsend frames and unframes Chrome native messages, for smoke-testing the host by hand:
//
//	go run ./cmd/nmsend -frame '{"id":"1","v":1,"cmd":"health"}' | ipswitch-host | go run ./cmd/nmsend -unframe
package main

import (
	"encoding/binary"
	"flag"
	"fmt"
	"io"
	"os"
)

func main() {
	frame := flag.Bool("frame", false, "write each argument as a framed message to stdout")
	unframe := flag.Bool("unframe", false, "read framed messages from stdin and print one per line")
	flag.Parse()
	switch {
	case *frame:
		for _, m := range flag.Args() {
			var hdr [4]byte
			binary.LittleEndian.PutUint32(hdr[:], uint32(len(m)))
			os.Stdout.Write(hdr[:])
			os.Stdout.Write([]byte(m))
		}
	case *unframe:
		for {
			var hdr [4]byte
			if _, err := io.ReadFull(os.Stdin, hdr[:]); err != nil {
				return
			}
			buf := make([]byte, binary.LittleEndian.Uint32(hdr[:]))
			if _, err := io.ReadFull(os.Stdin, buf); err != nil {
				fmt.Fprintln(os.Stderr, "short message:", err)
				os.Exit(1)
			}
			fmt.Println(string(buf))
		}
	default:
		flag.Usage()
		os.Exit(2)
	}
}
