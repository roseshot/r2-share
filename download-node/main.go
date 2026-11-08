package main

import (
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
	return &server{secret: []byte(secret), httpClient: client, now: time.Now, corsOrigin: cors}, nil
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
