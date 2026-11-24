package main

import (
	"encoding/json"
	"errors"
	"net/netip"
	"time"
)

// Config is what an adapter is configured to (the stored setting); also the snapshot.
type Config struct {
	DHCP    bool     `json:"dhcp"`
	Addrs   []string `json:"addrs"`
	Gateway string   `json:"gateway"`
	DNS     []string `json:"dns"`
}

// MarshalJSON writes empty lists as [] rather than null.
func (c Config) MarshalJSON() ([]byte, error) {
	type alias Config
	a := alias(c)
	if a.Addrs == nil {
		a.Addrs = []string{}
	}
	if a.DNS == nil {
		a.DNS = []string{}
	}
	return json.Marshal(a)
}

// Adapter is one network adapter: live values plus the stored config.
type Adapter struct {
	Index       int      `json:"index"`
	GUID        string   `json:"guid"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Status      string   `json:"status"`
	MAC         string   `json:"mac"`
	IsWifi      bool     `json:"isWifi"`
	IsInternet  bool     `json:"isInternet"`
	DHCP        bool     `json:"dhcp"`
	IPs         []string `json:"ips"`
	Gateway     string   `json:"gateway"`
	DNS         []string `json:"dns"`
	Config      Config   `json:"config"`

	// Inputs for isInternet; not part of the protocol.
	IfMetric    int `json:"-"`
	RouteMetric int `json:"-"` // -1 = no default route
}

func (a Adapter) MarshalJSON() ([]byte, error) {
	type alias Adapter
	b := alias(a)
	if b.IPs == nil {
		b.IPs = []string{}
	}
	if b.DNS == nil {
		b.DNS = []string{}
	}
	return json.Marshal(b)
}

// Context is the plant context a site-requested change carries.
type Context struct {
	PlantID     string `json:"plantId"`
	PlantName   string `json:"plantName"`
	EquipmentID string `json:"equipmentId"`
}

// Pending is a change inside its confirm window.
type Pending struct {
	Index    int    `json:"index"`
	GUID     string `json:"guid"`
	Adapter  string `json:"adapter"`
	Deadline int64  `json:"deadline"` // Unix ms
	Snapshot Config `json:"snapshot"`
	Applied  Config `json:"applied"`
	Profile  string `json:"profile"`
	Source   string `json:"source"`
}

// pendingFile is pending.json on disk: the protocol Pending plus what keep/revert need.
type pendingFile struct {
	Pending
	Context    *Context `json:"context,omitempty"`
	PrevStatic *Static  `json:"prevStatic,omitempty"`
}

func (p *pendingFile) deadline() time.Time { return time.UnixMilli(p.Deadline) }

// Static is an adapter left static by a profile.
type Static struct {
	GUID    string `json:"guid"`
	Index   int    `json:"index"`
	Adapter string `json:"adapter"`
	Profile string `json:"profile"`
	Since   int64  `json:"since"`
	Config  Config `json:"config"`
}

// Test is a ping result.
type Test struct {
	Host  string `json:"host"`
	OK    bool   `json:"ok"`
	RttMs int    `json:"rttMs"`
	Tries int    `json:"tries"`
}

// AuditEntry is one line of audit.log.
type AuditEntry struct {
	Time    string   `json:"time"`
	User    string   `json:"user"`
	Action  string   `json:"action"`
	Adapter string   `json:"adapter"`
	Index   int      `json:"index"`
	From    *Config  `json:"from"`
	To      *Config  `json:"to"`
	Profile string   `json:"profile"`
	Source  string   `json:"source"`
	Context *Context `json:"context"`
	Result  string   `json:"result"`
	Detail  string   `json:"detail"`
	Test    *Test    `json:"test"`
}

// system is everything that touches the OS, so the logic runs against a fake on a Mac.
type system interface {
	listAdapters(showAll bool) ([]Adapter, error)
	readConfig(guid string) (Config, error)
	netsh(args []string) (string, error)
	canWrite() (bool, error)
	ping(addr netip.Addr, timeout time.Duration) (ok bool, rttMs int, err error)
}

// hostError is a protocol error reply.
type hostError struct {
	Code    string
	Message string
	Detail  any
}

func (e *hostError) Error() string { return e.Code + ": " + e.Message }

func herr(code, msg string, detail any) *hostError {
	return &hostError{Code: code, Message: msg, Detail: detail}
}

// errTimeout marks a child process (netsh, PowerShell, reg) killed after 30 s.
var errTimeout = errors.New("timed out after 30 s")
