package main

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var validNodeHostname = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

func parseNodeDomain(raw string) (hostname, audience string, err error) {
	if raw == "" || strings.TrimSpace(raw) != raw || len(raw) > 259 {
		return "", "", errors.New("NODE_DOMAIN must be a DNS hostname, optionally followed by a non-default HTTPS port")
	}
	audience = strings.ToLower(raw)
	hostname = audience
	if strings.Contains(audience, ":") {
		var port string
		hostname, port, _ = strings.Cut(audience, ":")
		number, parseErr := strconv.Atoi(port)
		if parseErr != nil || number <= 0 || number > 65535 || number == 443 ||
			strconv.Itoa(number) != port {
			return "", "", errors.New("invalid NODE_DOMAIN port")
		}
	}
	if len(hostname) > 253 || !validNodeHostname.MatchString(hostname) ||
		net.ParseIP(hostname) != nil {
		return "", "", errors.New("NODE_DOMAIN must be a valid DNS hostname")
	}
	return hostname, audience, nil
}

func loadTLSConfig(hostname, certificateFile, keyFile string) (*tls.Config, error) {
	if certificateFile == "" || keyFile == "" {
		return nil, errors.New("TLS_CERT_FILE and TLS_KEY_FILE are required")
	}
	certificate, err := tls.LoadX509KeyPair(certificateFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("unable to load TLS certificate and private key: %w", err)
	}
	leaf, err := x509.ParseCertificate(certificate.Certificate[0])
	if err != nil {
		return nil, fmt.Errorf("invalid TLS certificate: %w", err)
	}
	if err := leaf.VerifyHostname(hostname); err != nil {
		return nil, fmt.Errorf("TLS certificate does not match NODE_DOMAIN: %w", err)
	}
	now := time.Now()
	if now.Before(leaf.NotBefore) || !now.Before(leaf.NotAfter) {
		return nil, errors.New("TLS certificate is not currently valid")
	}
	return &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{certificate},
		GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
			if !strings.EqualFold(hello.ServerName, hostname) {
				return nil, errors.New("unrecognized TLS server name")
			}
			return nil, nil
		},
	}, nil
}
