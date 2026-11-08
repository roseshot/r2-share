package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

type storageConfig struct {
	ID              string `json:"id"`
	Backend         string `json:"backend"`
	Bucket          string `json:"bucket"`
	Region          string `json:"region"`
	AccountID       string `json:"accountId,omitempty"`
	AccessKeyID     string `json:"accessKeyId,omitempty"`
	SecretAccessKey string `json:"secretAccessKey,omitempty"`
	KeyID           string `json:"keyId,omitempty"`
	ApplicationKey  string `json:"applicationKey,omitempty"`
}

var (
	validBucket  = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
	validAccount = regexp.MustCompile(`^[a-fA-F0-9]{32}$`)
	validRegion  = regexp.MustCompile(`^[a-z0-9-]+$`)
)

func (s storageConfig) endpoint() (host, region, accessKey, secretKey string, err error) {
	if !validStorage.MatchString(s.ID) || !validBucket.MatchString(s.Bucket) ||
		strings.Contains(s.Bucket, "..") || strings.Contains(s.Bucket, ".-") ||
		strings.Contains(s.Bucket, "-.") || (len(s.Bucket) >= 6 && strings.HasPrefix(s.Bucket, "s3.")) {
		return "", "", "", "", errors.New("invalid storage ID or bucket")
	}
	switch s.Backend {
	case "b2":
		if !regexp.MustCompile(`^[a-z]{2}-[a-z0-9-]+-[0-9]{3}$`).MatchString(s.Region) {
			return "", "", "", "", errors.New("invalid B2 region")
		}
		host, region, accessKey, secretKey = "s3."+s.Region+".backblazeb2.com", s.Region, s.KeyID, s.ApplicationKey
	case "r2":
		if !validAccount.MatchString(s.AccountID) {
			return "", "", "", "", errors.New("invalid R2 account ID")
		}
		host, region, accessKey, secretKey = strings.ToLower(s.AccountID)+".r2.cloudflarestorage.com", "auto", s.AccessKeyID, s.SecretAccessKey
	case "s3":
		if !validRegion.MatchString(s.Region) {
			return "", "", "", "", errors.New("invalid S3 region")
		}
		host, region, accessKey, secretKey = "s3."+s.Region+".amazonaws.com", s.Region, s.AccessKeyID, s.SecretAccessKey
	default:
		return "", "", "", "", errors.New("unsupported storage backend")
	}
	if len(accessKey) < 4 || len(secretKey) < 4 {
		return "", "", "", "", errors.New("storage credentials are missing")
	}
	return host, region, accessKey, secretKey, nil
}

func signHMAC(key []byte, msg string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(msg))
	return h.Sum(nil)
}

func signS3Request(method string, s storageConfig, objectKey, byteRange string, now time.Time) (*http.Request, error) {
	host, region, accessKey, secretKey, err := s.endpoint()
	if err != nil {
		return nil, err
	}
	if !validObject.MatchString(objectKey) {
		return nil, errors.New("invalid object key")
	}
	location := &url.URL{Scheme: "https", Host: host, Path: "/" + s.Bucket + "/" + objectKey}
	req, err := http.NewRequest(method, location.String(), nil)
	if err != nil {
		return nil, err
	}
	stamp, date := now.UTC().Format("20060102T150405Z"), now.UTC().Format("20060102")
	req.Header.Set("Accept-Encoding", "identity")
	req.Header.Set("X-Amz-Date", stamp)
	req.Header.Set("X-Amz-Content-Sha256", "UNSIGNED-PAYLOAD")
	headers := "host:" + host + "\n"
	signed := "host;"
	if byteRange != "" {
		req.Header.Set("Range", byteRange)
		headers += "range:" + byteRange + "\n"
		signed += "range;"
	}
	headers += "x-amz-content-sha256:UNSIGNED-PAYLOAD\n" + "x-amz-date:" + stamp + "\n"
	signed += "x-amz-content-sha256;x-amz-date"
	canonical := method + "\n" + location.EscapedPath() + "\n\n" + headers + "\n" + signed + "\nUNSIGNED-PAYLOAD"
	hash := sha256.Sum256([]byte(canonical))
	scope := date + "/" + region + "/s3/aws4_request"
	message := "AWS4-HMAC-SHA256\n" + stamp + "\n" + scope + "\n" + hex.EncodeToString(hash[:])
	signingKey := signHMAC([]byte("AWS4"+secretKey), date)
	signingKey = signHMAC(signingKey, region)
	signingKey = signHMAC(signingKey, "s3")
	signingKey = signHMAC(signingKey, "aws4_request")
	signature := hex.EncodeToString(signHMAC(signingKey, message))
	req.Header.Set("Authorization", fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s", accessKey, scope, signed, signature))
	return req, nil
}
