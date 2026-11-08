package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json/v2"
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type signedSource struct {
	Get  string `json:"get"`
	Head string `json:"head"`
}

var (
	validBucket = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
	validB2Host = regexp.MustCompile(`^s3\.[a-z]{2}-[a-z0-9-]+-[0-9]{3}\.backblazeb2\.com$`)
	validR2Host = regexp.MustCompile(`^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$`)
	validS3Host = regexp.MustCompile(`^s3\.[a-z0-9-]+\.amazonaws\.com$`)
	validSignature = regexp.MustCompile(`^[a-f0-9]{64}$`)
	validCredential = regexp.MustCompile(`^[^/]+/[0-9]{8}/[a-z0-9-]+/s3/aws4_request$`)
)

func decryptSource(raw string, secret []byte) (signedSource, error) {
	var source signedSource
	noncePart, ciphertextPart, ok := strings.Cut(raw, ".")
	if !ok || strings.Contains(ciphertextPart, ".") || len(raw) > 2600 {
		return source, errors.New("invalid encrypted source")
	}
	nonce, err := base64.RawURLEncoding.DecodeString(noncePart)
	if err != nil || len(nonce) != 12 {
		return source, errors.New("invalid source nonce")
	}
	sealed, err := base64.RawURLEncoding.DecodeString(ciphertextPart)
	if err != nil || len(sealed) < 16 || len(sealed) > 1900 {
		return source, errors.New("invalid source ciphertext")
	}
	key := sha256.Sum256(append([]byte("tuckbox-download-source/v1:"), secret...))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return source, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return source, err
	}
	plaintext, err := aead.Open(nil, nonce, sealed, nil)
	if err != nil || json.Unmarshal(plaintext, &source, json.RejectUnknownMembers(true)) != nil || source.Get == "" || source.Head == "" {
		return signedSource{}, errors.New("invalid encrypted source")
	}
	return source, nil
}

func validateSignedURL(raw, objectKey string, grantExpiry int64, now time.Time) (*url.URL, error) {
	if len(raw) > 950 {
		return nil, errors.New("invalid source URL length")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" ||
		u.Fragment != "" || u.Opaque != "" || u.Hostname() != u.Host {
		return nil, errors.New("invalid source URL")
	}
	host := u.Hostname()
	if !validB2Host.MatchString(host) && !validR2Host.MatchString(host) && !validS3Host.MatchString(host) {
		return nil, errors.New("untrusted storage hostname")
	}
	prefix, suffix, ok := strings.Cut(strings.TrimPrefix(u.EscapedPath(), "/"), "/")
	if !ok || !validBucket.MatchString(prefix) || strings.Contains(prefix, "..") ||
		strings.Contains(prefix, ".-") || strings.Contains(prefix, "-.") || suffix != objectKey {
		return nil, errors.New("invalid storage object path")
	}
	q := u.Query()
	required := []string{"X-Amz-Algorithm", "X-Amz-Date", "X-Amz-Expires", "X-Amz-Credential", "X-Amz-SignedHeaders", "X-Amz-Signature"}
	for _, name := range required {
		if len(q[name]) != 1 {
			return nil, errors.New("invalid source signature")
		}
	}
	if q.Get("X-Amz-Algorithm") != "AWS4-HMAC-SHA256" ||
		q.Get("X-Amz-SignedHeaders") != "host" ||
		!validSignature.MatchString(q.Get("X-Amz-Signature")) ||
		!validCredential.MatchString(q.Get("X-Amz-Credential")) {
		return nil, errors.New("invalid source signature")
	}
	seconds, err := strconv.Atoi(q.Get("X-Amz-Expires"))
	if err != nil || seconds < 1 || seconds > 90 {
		return nil, errors.New("invalid source expiry")
	}
	signedAt, err := time.Parse("20060102T150405Z", q.Get("X-Amz-Date"))
	if err != nil || signedAt.After(now.Add(30*time.Second)) ||
		!signedAt.Add(time.Duration(seconds)*time.Second).After(now) ||
		signedAt.Add(time.Duration(seconds)*time.Second).UnixMilli() > grantExpiry {
		return nil, errors.New("expired source signature")
	}
	return u, nil
}
