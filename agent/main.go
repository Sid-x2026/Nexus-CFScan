// nexus-cfscan-agent — local scanning backend for the Nexus-CFScan frontend.
//
// Stdlib-only Go service. Listens on 127.0.0.1:13335 (falls back to
// 13336..13344 if occupied) and implements the REST contract the
// frontend (~/workspace/cf/src/utils/localAgent.ts) expects:
//
//	GET  /status            -> service status / current task
//	POST /scan              -> start an async scan (409 if one is running)
//	GET  /progress?since=N  -> incremental qualified results
//	POST /stop              -> cancel the running scan
//
// Scanning rules are NOT hard-coded here: every scan takes its
// thresholds from the POST /scan payload sent by the frontend
// (latencyLimit, lossLimit, rounds, jitter, coloFilter, topN, ...).
// Only qualified results are returned; v1 does no download speed
// test (speedUrl is accepted and ignored, speedMbps is omitted).
package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptrace"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	version     = "0.1.0"
	serviceName = "nexus-cfscan-agent"
	basePort    = 13335
	maxPortTry  = 10
)

var tlsPorts = map[int]bool{443: true, 2053: true, 2083: true, 2087: true, 2096: true, 8443: true}

var defaultColoFilter = []string{"HKG", "NRT", "SIN", "ICN", "TPE"}

// ---------------------------------------------------------------------------
// Types (field names match the frontend's AgentScanPayload / AgentResult)
// ---------------------------------------------------------------------------

type Target struct {
	Host string `json:"host"`
	IP   string `json:"ip"`
	Port int    `json:"port"`
}

type ScanPayload struct {
	Targets      []Target `json:"targets"`
	Threads      int      `json:"threads"`
	TimeoutMs    int      `json:"timeoutMs"`
	LatencyLimit int      `json:"latencyLimit"`
	SNI          string   `json:"sni"`
	HTTPHost     string   `json:"httpHost"`
	Source       string   `json:"source"`
	Rounds       int      `json:"rounds"`
	LossLimit    float64  `json:"lossLimit"`
	JitterStable int      `json:"jitterStable"`
	JitterBackup int      `json:"jitterBackup"`
	ScanMode     string   `json:"scanMode"`
	PortMode     string   `json:"portMode"`
	ColoFilter   []string `json:"coloFilter"`
	TopN         int      `json:"topN"`
	SpeedURL     string   `json:"speedUrl"`
}

type AgentResult struct {
	Host      string   `json:"host"`
	IP        string   `json:"ip"`
	Port      int      `json:"port"`
	TCPMs     int      `json:"tcpMs"`
	TLSMs     int      `json:"tlsMs"`
	Latency   int      `json:"latency"`
	Colo      string   `json:"colo"`
	Loc       string   `json:"loc"`
	OK        bool     `json:"ok"`
	Error     string   `json:"error"`
	Status    int      `json:"status"`
	TS        int64    `json:"ts"`
	Latencies []int    `json:"latencies,omitempty"`
	LossPct   float64  `json:"lossPct"`
	JitterMs  int      `json:"jitterMs"`
	SpeedMbps *float64 `json:"speedMbps,omitempty"` // v1: always omitted (no speed test)
	Source    string   `json:"source,omitempty"`
}

type taskInfo struct {
	TaskID     string `json:"taskId"`
	Done       int    `json:"done"`
	Total      int    `json:"total"`
	StartedAt  int64  `json:"startedAt"`
	FinishedAt int64  `json:"finishedAt,omitempty"`
}

type statusResp struct {
	OK      bool      `json:"ok"`
	Service string    `json:"service"`
	Version string    `json:"version"`
	Running bool      `json:"running"`
	Task    *taskInfo `json:"task"`
}

type progressResp struct {
	OK         bool          `json:"ok"`
	TaskID     string        `json:"taskId"`
	Running    bool          `json:"running"`
	Done       int           `json:"done"`
	Total      int           `json:"total"`
	Since      int           `json:"since"`
	Count      int           `json:"count"`
	Results    []AgentResult `json:"results"`
	StartedAt  int64         `json:"startedAt"`
	FinishedAt int64         `json:"finishedAt"`
}

// ---------------------------------------------------------------------------
// Task state
// ---------------------------------------------------------------------------

type scanTask struct {
	id         string
	total      int
	done       int64 // atomic
	startedAt  int64
	finishedAt int64
	running    bool
	cancel     context.CancelFunc

	mu sync.Mutex
	// ordered: qualified results in completion order (stable for ?since= polling)
	ordered []AgentResult
	// final: sorted by latency, capped to topN — set when the task finishes,
	// served to a fresh reader (since=0) after completion.
	final []AgentResult
}

var (
	taskMu      sync.Mutex
	currentTask *scanTask
	taskSeq     int64
)

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

func ms(d time.Duration) int {
	if d < 0 {
		return 0
	}
	return int(d.Round(time.Millisecond) / time.Millisecond)
}

func isDomain(host string) bool {
	if strings.Contains(host, ":") { // IPv6
		return false
	}
	parts := strings.Split(host, ".")
	if len(parts) == 4 {
		allNum := true
		for _, p := range parts {
			if _, err := strconv.Atoi(p); err != nil {
				allNum = false
				break
			}
		}
		if allNum {
			return false
		}
	}
	return strings.Contains(host, ".")
}

// one TCPing round: plain TCP dial, returns ms or -1 on failure.
func tcpingRound(ip string, port int, timeout time.Duration) (int, error) {
	addr := net.JoinHostPort(ip, strconv.Itoa(port))
	start := time.Now()
	conn, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return -1, err
	}
	_ = conn.Close()
	return ms(time.Since(start)), nil
}

// one HTTPing round: measures TTFB. Returns (ttfbMs, tcpMs, tlsMs, err).
// tcpMs/tlsMs come from httptrace; tlsMs is -1 when the port is plain HTTP.
func httpingRound(ip string, port int, host string, timeout time.Duration) (ttfb, tcpMs, tlsMs int, err error) {
	tlsMs = -1
	useTLS := tlsPorts[port]
	scheme := "http"
	if useTLS {
		scheme = "https"
	}
	sni := "speed.cloudflare.com"
	if isDomain(host) {
		sni = host
	}
	var connStart, connDone, tlsDone, firstByte time.Time
	trace := &httptrace.ClientTrace{
		ConnectStart:         func(_, _ string) { connStart = time.Now() },
		ConnectDone:          func(_, _ string, _ error) { connDone = time.Now() },
		TLSHandshakeDone:     func(_ tls.ConnectionState, _ error) { tlsDone = time.Now() },
		GotFirstResponseByte: func() { firstByte = time.Now() },
	}
	dialer := &net.Dialer{Timeout: timeout}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			// Always dial the raw IP, never the hostname.
			return dialer.DialContext(ctx, network, net.JoinHostPort(ip, strconv.Itoa(port)))
		},
		TLSClientConfig: &tls.Config{ServerName: sni, InsecureSkipVerify: true}, //nolint:gosec // IP dial: cert cannot match; SNI is what matters
	}
	client := &http.Client{Transport: transport, Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	url := fmt.Sprintf("%s://%s/cdn-cgi/trace", scheme, sni)
	req, err := http.NewRequestWithContext(httptrace.WithClientTrace(context.Background(), trace), http.MethodGet, url, nil)
	if err != nil {
		return -1, -1, -1, err
	}
	req.Host = sni
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return -1, -1, -1, err
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	if firstByte.IsZero() {
		firstByte = time.Now()
	}
	if !connStart.IsZero() && !connDone.IsZero() {
		tcpMs = ms(connDone.Sub(connStart))
	}
	if useTLS && !tlsDone.IsZero() && !connDone.IsZero() {
		tlsMs = ms(tlsDone.Sub(connDone))
	}
	_ = start
	return ms(firstByte.Sub(start)), tcpMs, tlsMs, nil
}

// detectColo dials ip:port over TLS (SNI speed.cloudflare.com) and reads
// /cdn-cgi/trace. Returns (colo, loc); on any failure both are "".
func detectColo(ip string, port int, timeout time.Duration) (string, string) {
	sni := "speed.cloudflare.com"
	dialer := &net.Dialer{Timeout: timeout}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return dialer.DialContext(ctx, network, net.JoinHostPort(ip, strconv.Itoa(port)))
		},
		TLSClientConfig: &tls.Config{ServerName: sni, InsecureSkipVerify: true}, //nolint:gosec
	}
	client := &http.Client{Transport: transport, Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Get("https://" + sni + "/cdn-cgi/trace")
	if err != nil {
		return "", ""
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return "", ""
	}
	var colo, loc string
	for _, line := range strings.Split(string(body), "\n") {
		kv := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(kv) != 2 {
			continue
		}
		switch kv[0] {
		case "colo":
			colo = kv[1]
		case "loc":
			loc = kv[1]
		}
	}
	return colo, loc
}

// measureTarget runs `rounds` measurements for one target and returns a
// qualified AgentResult, or nil if the target does not qualify.
func measureTarget(ctx context.Context, t Target, p ScanPayload) *AgentResult {
	timeout := time.Duration(p.TimeoutMs) * time.Millisecond
	rounds := p.Rounds
	if rounds < 1 {
		rounds = 1
	}
	var latencies []int
	var tcpBest = -1
	var tlsBest = -1
	failures := 0
	for i := 0; i < rounds; i++ {
		select {
		case <-ctx.Done():
			return nil
		default:
		}
		var lat, tcp, tlsv int
		var err error
		if p.ScanMode == "httping" {
			lat, tcp, tlsv, err = httpingRound(t.IP, t.Port, t.Host, timeout)
		} else {
			lat, err = tcpingRound(t.IP, t.Port, timeout)
			tcp, tlsv = lat, -1
		}
		if err != nil || lat < 0 {
			failures++
			continue
		}
		latencies = append(latencies, lat)
		if tcp >= 0 && (tcpBest < 0 || tcp < tcpBest) {
			tcpBest = tcp
		}
		if tlsv >= 0 && (tlsBest < 0 || tlsv < tlsBest) {
			tlsBest = tlsv
		}
	}
	if len(latencies) == 0 {
		return nil
	}
	best := latencies[0]
	worst := latencies[0]
	for _, v := range latencies[1:] {
		if v < best {
			best = v
		}
		if v > worst {
			worst = v
		}
	}
	lossPct := float64(failures) / float64(rounds) * 100
	// Qualification: at least one success, best latency within limit,
	// loss within limit. (rounds=3 + lossLimit=10 => all 3 must succeed.)
	if best > p.LatencyLimit || lossPct > p.LossLimit {
		return nil
	}
	jitter := 0
	if len(latencies) >= 2 {
		jitter = worst - best
	}
	res := &AgentResult{
		Host:      t.Host,
		IP:        t.IP,
		Port:      t.Port,
		TCPMs:     tcpBest,
		TLSMs:     tlsBest,
		Latency:   best,
		OK:        true,
		Error:     "",
		Status:    200,
		TS:        time.Now().UnixMilli(),
		Latencies: latencies,
		LossPct:   lossPct,
		JitterMs:  jitter,
		Source:    p.Source,
	}
	// Colo detection only for qualified candidates. A failed detection
	// does NOT drop the result; a detected colo outside the filter does.
	colo, loc := detectColo(t.IP, t.Port, 5*time.Second)
	res.Colo, res.Loc = colo, loc
	if colo != "" && len(p.ColoFilter) > 0 {
		allowed := false
		for _, c := range p.ColoFilter {
			if c == colo {
				allowed = true
				break
			}
		}
		if !allowed {
			return nil
		}
	}
	return res
}

func runScan(task *scanTask, p ScanPayload, ctx context.Context) {
	defer func() {
		task.mu.Lock()
		task.running = false
		task.finishedAt = time.Now().UnixMilli()
		// Final list: sorted by latency, capped to topN.
		final := append([]AgentResult(nil), task.ordered...)
		sort.Slice(final, func(i, j int) bool { return final[i].Latency < final[j].Latency })
		if p.TopN > 0 && len(final) > p.TopN {
			final = final[:p.TopN]
		}
		task.final = final
		task.mu.Unlock()
	}()

	threads := p.Threads
	if threads < 1 {
		threads = 1
	}
	jobs := make(chan Target)
	var wg sync.WaitGroup
	for i := 0; i < threads; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for t := range jobs {
				if res := measureTarget(ctx, t, p); res != nil {
					task.mu.Lock()
					task.ordered = append(task.ordered, *res)
					task.mu.Unlock()
				}
				atomic.AddInt64(&task.done, 1)
			}
		}()
	}
sendLoop:
	for _, t := range p.Targets {
		select {
		case <-ctx.Done():
			break sendLoop
		case jobs <- t:
		}
	}
	close(jobs)
	wg.Wait()
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func cors(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}

func snapshotTask() *scanTask {
	taskMu.Lock()
	defer taskMu.Unlock()
	return currentTask
}

func handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
		return
	}
	t := snapshotTask()
	resp := statusResp{OK: true, Service: serviceName, Version: version}
	if t != nil {
		resp.Running = t.running
		resp.Task = &taskInfo{TaskID: t.id, Done: int(atomic.LoadInt64(&t.done)), Total: t.total, StartedAt: t.startedAt, FinishedAt: t.finishedAt}
	}
	writeJSON(w, http.StatusOK, resp)
}

func handleScan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
		return
	}
	var p ScanPayload
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid JSON: " + err.Error()})
		return
	}
	if len(p.Targets) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "no targets"})
		return
	}
	// Defaults (same as the frontend's DEFAULT_SCAN_PARAMS).
	if p.Threads < 1 {
		p.Threads = 8
	}
	if p.TimeoutMs <= 0 {
		p.TimeoutMs = 5000
	}
	if p.LatencyLimit <= 0 {
		p.LatencyLimit = 180
	}
	if p.LossLimit < 0 {
		p.LossLimit = 10
	}
	if p.Rounds < 1 {
		p.Rounds = 3
	}
	if p.JitterStable <= 0 {
		p.JitterStable = 50
	}
	if p.JitterBackup <= 0 {
		p.JitterBackup = 100
	}
	if p.ScanMode != "httping" {
		p.ScanMode = "tcping"
	}
	if p.ColoFilter == nil {
		p.ColoFilter = append([]string(nil), defaultColoFilter...)
	}
	if p.TopN <= 0 {
		p.TopN = 20
	}
	// NOTE: portMode is accepted but not acted on — the frontend already
	// picks the port per target. speedUrl is accepted but ignored in v1
	// (no download speed test).

	taskMu.Lock()
	if currentTask != nil && currentTask.running {
		taskMu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": "a scan is already running"})
		return
	}
	taskSeq++
	ctx, cancel := context.WithCancel(context.Background())
	task := &scanTask{
		id:        fmt.Sprintf("task-%d", taskSeq),
		total:     len(p.Targets),
		startedAt: time.Now().UnixMilli(),
		running:   true,
		cancel:    cancel,
	}
	currentTask = task
	taskMu.Unlock()

	go runScan(task, p, ctx)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "taskId": task.id, "total": task.total})
}

func handleProgress(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
		return
	}
	since, _ := strconv.Atoi(r.URL.Query().Get("since"))
	if since < 0 {
		since = 0
	}
	t := snapshotTask()
	if t == nil {
		writeJSON(w, http.StatusOK, progressResp{OK: true, Running: false, Results: []AgentResult{}})
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	resp := progressResp{
		OK:         true,
		TaskID:     t.id,
		Running:    t.running,
		Done:       int(atomic.LoadInt64(&t.done)),
		Total:      t.total,
		Since:      since,
		StartedAt:  t.startedAt,
		FinishedAt: t.finishedAt,
		Results:    []AgentResult{},
	}
	// Fresh read (since=0) of a finished task gets the final sorted,
	// topN-capped list. Incremental polling gets the stable
	// completion-order list so ?since= offsets never shift.
	list := t.ordered
	if !t.running && since == 0 && t.final != nil {
		list = t.final
	}
	if since < len(list) {
		chunk := append([]AgentResult(nil), list[since:]...)
		resp.Results = chunk
		resp.Count = len(chunk)
	}
	writeJSON(w, http.StatusOK, resp)
}

func handleStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
		return
	}
	t := snapshotTask()
	if t != nil && t.running && t.cancel != nil {
		t.cancel()
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func main() {
	log.SetOutput(os.Stdout)
	var ln net.Listener
	var err error
	port := 0
	for p := basePort; p < basePort+maxPortTry; p++ {
		ln, err = net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(p)))
		if err == nil {
			port = p
			break
		}
	}
	if ln == nil {
		log.Fatalf("cannot listen on 127.0.0.1:%d-%d: %v", basePort, basePort+maxPortTry-1, err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/status", cors(handleStatus))
	mux.HandleFunc("/scan", cors(handleScan))
	mux.HandleFunc("/progress", cors(handleProgress))
	mux.HandleFunc("/stop", cors(handleStop))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "not found"})
	})
	log.Printf("nexus-cfscan-agent %s listening on http://127.0.0.1:%d", version, port)
	log.Printf("endpoints: GET /status, POST /scan, GET /progress?since=N, POST /stop")
	if err := http.Serve(ln, mux); err != nil {
		log.Fatal(err)
	}
}
