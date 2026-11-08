package main

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type server struct {
	secret     []byte
	storages   map[string]storageConfig
	httpClient *http.Client
	now        func() time.Time
	corsOrigin string
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok\n")
	})
	mux.HandleFunc("/v1/download", s.download)
	return mux
}

func parseRange(raw string, size int64) (string, string, int64, error) {
	if raw == "" {
		return "", "", size, nil
	}
	if !strings.HasPrefix(raw, "bytes=") || strings.Contains(raw, ",") || size < 1 {
		return "", "", 0, errors.New("unsupported range")
	}
	bits := strings.Split(strings.TrimPrefix(raw, "bytes="), "-")
	if len(bits) != 2 || bits[0] == "" && bits[1] == "" {
		return "", "", 0, errors.New("invalid byte range")
	}
	var start, end int64
	if bits[0] == "" {
		n, err := strconv.ParseInt(bits[1], 10, 64)
		if err != nil || n <= 0 {
			return "", "", 0, errors.New("invalid suffix range")
		}
		start = size - n
		if start < 0 {
			start = 0
		}
		end = size - 1
	} else {
		var err error
		start, err = strconv.ParseInt(bits[0], 10, 64)
		if err != nil || start < 0 || start >= size {
			return "", "", 0, errors.New("invalid range start")
		}
		end = size - 1
		if bits[1] != "" {
			end, err = strconv.ParseInt(bits[1], 10, 64)
			if err != nil || end < start {
				return "", "", 0, errors.New("invalid range end")
			}
			if end >= size {
				end = size - 1
			}
		}
	}
	header := fmt.Sprintf("bytes=%d-%d", start, end)
	return header, fmt.Sprintf("bytes %d-%d/%d", start, end, size), end - start + 1, nil
}

func (s *server) download(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if s.corsOrigin != "" && r.Header.Get("Origin") == s.corsOrigin {
		w.Header().Set("Access-Control-Allow-Origin", s.corsOrigin)
		w.Header().Set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Disposition, Content-Range, Content-Length")
		w.Header().Set("Vary", "Origin")
	}
	c, err := verifyToken(r.URL.Query().Get("token"), s.secret, r.Host, s.now())
	if err != nil {
		http.Error(w, "invalid or expired download token", http.StatusForbidden)
		return
	}
	storage, ok := s.storages[c.StorageID]
	if !ok {
		http.Error(w, "storage unavailable", http.StatusServiceUnavailable)
		return
	}
	if r.Method == http.MethodHead {
		// Worker handles the normal HEAD preflight. This is for direct clients.
		s.fetchObject(w, r, storage, c, "", "", c.Size)
		return
	}
	raw := r.Header.Get("Range")
	if r.Header.Get("If-Range") != "" {
		raw = ""
	}
	byteRange, contentRange, expected, err := parseRange(raw, c.Size)
	if err != nil {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", c.Size))
		w.Header().Set("Accept-Ranges", "bytes")
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return
	}
	s.fetchObject(w, r, storage, c, byteRange, contentRange, expected)
}

func (s *server) fetchObject(w http.ResponseWriter, r *http.Request, storage storageConfig, c claims, byteRange, contentRange string, expected int64) {
	request, err := signS3Request(r.Method, storage, c.Key, byteRange, s.now())
	if err != nil {
		http.Error(w, "storage configuration error", http.StatusServiceUnavailable)
		return
	}
	request = request.WithContext(r.Context())
	response, err := s.httpClient.Do(request)
	if err != nil {
		slog.Warn("bucket request failed", "error", err)
		http.Error(w, "storage unavailable", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	expectedStatus := http.StatusOK
	if byteRange != "" {
		expectedStatus = http.StatusPartialContent
	}
	if response.StatusCode == http.StatusNotFound {
		http.Error(w, "file not found", http.StatusNotFound)
		return
	}
	if response.StatusCode != expectedStatus ||
		response.ContentLength != expected ||
		(contentRange != "" && response.Header.Get("Content-Range") != contentRange) {
		slog.Warn("storage response mismatch", "status", response.StatusCode, "size", response.ContentLength)
		http.Error(w, "storage response mismatch", http.StatusBadGateway)
		return
	}
	mime := c.MIME
	if mime == "" {
		mime = "application/octet-stream"
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Disposition", "attachment; filename=\"download\"; filename*=UTF-8''"+url.PathEscape(c.Filename))
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Length", strconv.FormatInt(expected, 10))
	if contentRange != "" {
		w.Header().Set("Content-Range", contentRange)
	}
	w.WriteHeader(expectedStatus)
	if r.Method != http.MethodHead {
		if _, err := io.CopyN(w, response.Body, expected); err != nil {
			slog.Warn("download interrupted", "error", err)
		}
	}
}
