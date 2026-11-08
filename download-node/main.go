package main

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"time"
)

func loadServer() (*server, error) {
	secret := os.Getenv("DOWNLOAD_NODE_SECRET")
	if len(secret) < 32 {
		return nil, errors.New("DOWNLOAD_NODE_SECRET must be at least 32 characters")
	}
	var list []storageConfig
	if err := json.Unmarshal([]byte(os.Getenv("STORAGES_JSON")), &list); err != nil {
		return nil, errors.New("invalid STORAGES_JSON")
	}
	if len(list) < 1 || len(list) > 32 {
		return nil, errors.New("STORAGES_JSON requires 1–32 entries")
	}
	stores := make(map[string]storageConfig, len(list))
	for _, item := range list {
		if _, ok := stores[item.ID]; ok {
			return nil, errors.New("duplicate storage ID")
		}
		if _, _, _, _, err := item.endpoint(); err != nil {
			return nil, err
		}
		stores[item.ID] = item
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	transport.ResponseHeaderTimeout = 25 * time.Second
	transport.MaxIdleConnsPerHost = 16
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	cors := os.Getenv("CORS_ORIGIN")
	if cors != "" {
		parsed, err := url.Parse(cors)
		if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil ||
			parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
			return nil, errors.New("CORS_ORIGIN must be an HTTPS origin")
		}
	}
	return &server{secret: []byte(secret), storages: stores, httpClient: client, now: time.Now, corsOrigin: cors}, nil
}

func main() {
	srv, err := loadServer()
	if err != nil {
		slog.Error("download node configuration error", "error", err)
		os.Exit(1)
	}
	address := os.Getenv("LISTEN_ADDR")
	if address == "" {
		address = ":8080"
	}
	httpServer := &http.Server{Addr: address, Handler: srv.routes(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second}
	slog.Info("TuckBox download node listening", "address", address)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
}
