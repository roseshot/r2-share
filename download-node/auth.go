package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json/v2"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
	"uuid"
)

const tokenTTL = 90 * time.Second
const tokenScope = "tuckbox-download/v1"

var (
	validLegacyObject = regexp.MustCompile(`^files/[A-Za-z0-9_-]{16}$`)
	validStorage = regexp.MustCompile(`^[a-z][a-z0-9_-]{1,31}$`)
	validMime    = regexp.MustCompile(`^[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+$`)
)

// Accept canonical UUIDv4 keys and the original 16-character legacy file keys.
func validObjectKey(key string) bool {
	if validLegacyObject.MatchString(key) {
		return true
	}
	raw, ok := strings.CutPrefix(key, "tuckbox/")
	if !ok || len(raw) != 36 {
		return false
	}
	id, err := uuid.Parse(raw)
	return err == nil && strings.EqualFold(id.String(), raw) &&
		id[6]>>4 == 4 && id[8]&0xc0 == 0x80
}

type claims struct {
	Scope     string `json:"scope"`
	Key       string `json:"key"`
	StorageID string `json:"storageId"`
	Source    string `json:"source"`
	Filename  string `json:"filename"`
	MIME      string `json:"mime"`
	Size      int64  `json:"size"`
	Audience  string `json:"aud"`
	Exp       int64  `json:"exp"` // Unix epoch milliseconds, matching Worker signToken.
}

func checkClaims(c claims, audience string, now time.Time) error {
	if c.Scope != tokenScope || c.Audience != audience || c.Exp <= now.UnixMilli() ||
		c.Exp > now.Add(tokenTTL).UnixMilli() || c.Size < 1 || c.Size > 9007199254740991 ||
		!validObjectKey(c.Key) || !validStorage.MatchString(c.StorageID) ||
		len(c.Source) < 1 || len(c.Source) > 2600 ||
		c.Filename == "" || len(c.Filename) > 1024 || !utf8.ValidString(c.Filename) ||
		strings.ContainsAny(c.Filename, "\r\n\x00") {
		return errors.New("invalid or expired download grant")
	}
	if c.MIME != "" && !validMime.MatchString(c.MIME) {
		return errors.New("invalid content type")
	}
	return nil
}

func verifyToken(raw string, secret []byte, audience string, now time.Time) (claims, error) {
	var c claims
	if len(raw) == 0 || len(raw) > 4096 || strings.Count(raw, ".") != 1 {
		return c, errors.New("invalid download token")
	}
	parts := strings.SplitN(raw, ".", 2)
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(sig) != sha256.Size {
		return c, errors.New("invalid signature")
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(parts[0]))
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return c, errors.New("invalid signature")
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || len(body) > 3072 {
		return c, errors.New("invalid token body")
	}
	if err := json.Unmarshal(body, &c, json.RejectUnknownMembers(true)); err != nil {
		return c, errors.New("invalid claims")
	}
	if err := checkClaims(c, audience, now); err != nil {
		return c, err
	}
	return c, nil
}
