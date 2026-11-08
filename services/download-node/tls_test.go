package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testCertificateFiles(t *testing.T, domain string) (string, string, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject: pkix.Name{CommonName: domain},
		DNSNames: []string{domain},
		NotBefore: time.Now().Add(-time.Hour),
		NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA: true,
	}
	certDER, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	dir := t.TempDir()
	certFile := filepath.Join(dir, "server.crt")
	keyFile := filepath.Join(dir, "server.key")
	if err := os.WriteFile(certFile, certPEM, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyFile, keyPEM, 0600); err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(certPEM)
	return certFile, keyFile, roots
}

func TestNodeDomainValidation(t *testing.T) {
	for _, tt := range []struct {
		value, host, audience string
	}{
		{"download.example.com", "download.example.com", "download.example.com"},
		{"DOWNLOAD.EXAMPLE.COM", "download.example.com", "download.example.com"},
		{"download.example.com:8443", "download.example.com", "download.example.com:8443"},
	} {
		host, audience, err := parseNodeDomain(tt.value)
		if err != nil || host != tt.host || audience != tt.audience {
			t.Errorf("parseNodeDomain(%q) returned %q, %q, %v", tt.value, host, audience, err)
		}
	}
	for _, invalid := range []string{
		"", "localhost", "127.0.0.1", "[::1]", "*.example.com",
		"https://download.example.com", "download.example.com/path",
		"download.example.com.", "download.example.com?x=1",
		"download.example.com:443", "download.example.com:0",
		"download.example.com:65536", "download.example.com:08443",
		"download.example.com:abc", "download.example.com:8443:8444",
		"download..example.com", "download_example.com",
		"-download.example.com", "download.example.com ",
	} {
		if _, _, err := parseNodeDomain(invalid); err == nil {
			t.Errorf("accepted invalid NODE_DOMAIN %q", invalid)
		}
	}
}

func TestTLSCertificateValidation(t *testing.T) {
	if config, err := loadTLSConfig("download.example.com", "", ""); err != nil || config != nil {
		t.Fatalf("TLS should be disabled when neither file is configured: config=%v err=%v", config, err)
	}
	certFile, keyFile, _ := testCertificateFiles(t, "download.example.com")
	config, err := loadTLSConfig("download.example.com", certFile, keyFile)
	if err != nil || config.MinVersion != tls.VersionTLS12 {
		t.Fatalf("valid TLS configuration rejected: %v", err)
	}
	for _, tt := range []struct{ domain, certFile, keyFile string }{
		{"wrong.example.com", certFile, keyFile},
		{"download.example.com", "", keyFile},
		{"download.example.com", certFile, ""},
		{"download.example.com", "/missing/cert", keyFile},
		{"download.example.com", keyFile, certFile},
	} {
		if _, err := loadTLSConfig(tt.domain, tt.certFile, tt.keyFile); err == nil {
			t.Errorf("accepted invalid certificate settings for %q", tt.domain)
		}
	}
}


func TestHTTPListenerWithoutTLSFiles(t *testing.T) {
	t.Setenv("NODE_DOMAIN", "download.example.com")
	t.Setenv("TLS_CERT_FILE", "")
	t.Setenv("TLS_KEY_FILE", "")
	t.Setenv("DOWNLOAD_NODE_SECRET", testSecret)
	t.Setenv("CORS_ORIGIN", "")

	node, err := loadServer()
	if err != nil {
		t.Fatalf("HTTP configuration rejected: %v", err)
	}
	if node.tlsConfig != nil {
		t.Fatal("HTTP mode unexpectedly enabled TLS")
	}
	remote := httptest.NewServer(node.routes())
	defer remote.Close()

	for _, tt := range []struct {
		host, path string
		status int
	}{
		{"download.example.com", "/healthz", http.StatusOK},
		{"other.example.com", "/healthz", http.StatusMisdirectedRequest},
		{"download.example.com", "/v1/download", http.StatusForbidden},
	} {
		req, err := http.NewRequest(http.MethodGet, remote.URL+tt.path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Host = tt.host
		response, err := remote.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != tt.status {
			t.Errorf("HTTP host %q path %q: got %d, want %d", tt.host, tt.path, response.StatusCode, tt.status)
		}
	}

	// HTTP mode still verifies the signed grant before streaming private content.
	stub, claims := testNode(func(*http.Request) (*http.Response, error) {
		return upstream(http.StatusOK, "sample", nil), nil
	})
	node.httpClient = stub.httpClient
	node.now = stub.now
	request, err := http.NewRequest(http.MethodGet, remote.URL+"/v1/download?token="+grant(claims), nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Host = node.domain
	response, err := remote.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || string(body) != "sample" {
		t.Fatalf("authorized HTTP download returned %d %q", response.StatusCode, body)
	}
}

func TestRejectUnrecognizedHTTPDomains(t *testing.T) {
	node, claims := testNode(func(*http.Request) (*http.Response, error) {
		t.Fatal("mismatched domain must not contact storage")
		return nil, nil
	})
	for _, path := range []string{"/healthz", "/v1/download?token=" + grant(claims)} {
		for _, host := range []string{"other.example.com", "download.example.com:8443",
			"download.example.com.", "127.0.0.1"} {
			req := httptest.NewRequest("GET", "https://download.example.com"+path, nil)
			req.Host = host
			rec := httptest.NewRecorder()
			node.routes().ServeHTTP(rec, req)
			if rec.Code != http.StatusMisdirectedRequest {
				t.Errorf("Host %q on %s returned %d", host, path, rec.Code)
			}
		}
		req := httptest.NewRequest("GET", "https://download.example.com"+path, nil)
		req.TLS.ServerName = "other.example.com"
		rec := httptest.NewRecorder()
		node.routes().ServeHTTP(rec, req)
		if rec.Code != http.StatusMisdirectedRequest {
			t.Errorf("unrecognized SNI on %s returned %d", path, rec.Code)
		}
		req = httptest.NewRequest("GET", "http://download.example.com"+path, nil)
		rec = httptest.NewRecorder()
		node.routes().ServeHTTP(rec, req)
		if rec.Code != http.StatusMisdirectedRequest {
			t.Errorf("plain HTTP on %s returned %d", path, rec.Code)
		}
	}
}

func TestTLSListenerEnforcesSNIAndHost(t *testing.T) {
	certFile, keyFile, roots := testCertificateFiles(t, "download.example.com")
	t.Setenv("NODE_DOMAIN", "download.example.com")
	t.Setenv("TLS_CERT_FILE", certFile)
	t.Setenv("TLS_KEY_FILE", keyFile)
	t.Setenv("DOWNLOAD_NODE_SECRET", testSecret)
	node, err := loadServer()
	if err != nil {
		t.Fatal(err)
	}
	remote := httptest.NewUnstartedServer(node.routes())
	remote.TLS = node.tlsConfig
	remote.StartTLS()
	defer remote.Close()

	dial := func(_ context.Context, _, _ string) (net.Conn, error) {
		return net.Dial("tcp", remote.Listener.Addr().String())
	}
	client := &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{RootCAs: roots},
		DialContext: dial,
	}}
	defer client.CloseIdleConnections()

	res, err := client.Get("https://download.example.com/healthz")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("valid SNI and Host returned %d", res.StatusCode)
	}

	req, _ := http.NewRequest("GET", "https://download.example.com/healthz", nil)
	req.Host = "other.example.com"
	res, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusMisdirectedRequest {
		t.Fatalf("invalid Host returned %d", res.StatusCode)
	}

	badClient := &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		DialContext: dial,
	}}
	defer badClient.CloseIdleConnections()
	if res, err := badClient.Get("https://other.example.com/healthz"); err == nil {
		res.Body.Close()
		t.Fatal("TLS handshake accepted an unrecognized SNI")
	}
}

func TestConfiguredHostWithCustomPort(t *testing.T) {
	node, claims := testNode(func(*http.Request) (*http.Response, error) {
		return upstream(200, "sample", nil), nil
	})
	node.domain = "download.example.com:8443"
	claims.Audience = node.domain
	req := httptest.NewRequest("GET", "https://download.example.com:8443/v1/download?token="+grant(claims), nil)
	// The TLS SNI contains the hostname, not the port included in HTTP Host.
	req.TLS.ServerName = "download.example.com"
	rec := httptest.NewRecorder()
	node.routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Body.String() != "sample" {
		t.Fatalf("valid custom port returned %d %q", rec.Code, rec.Body.String())
	}
	req.Host = strings.TrimSuffix(node.domain, ":8443")
	rec = httptest.NewRecorder()
	node.routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusMisdirectedRequest {
		t.Fatalf("missing configured port returned %d", rec.Code)
	}
}
