package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

const testSecret = "node-test-secret-32-characters-at-least"
const testKey = "tuckbox/3d4071e7-a4b3-4c06-9801-61f4aca13052"

func grant(c claims) string {
	body, _ := json.Marshal(c)
	return grantPayload(body)
}

func grantPayload(body []byte) string {
	encoded := base64.RawURLEncoding.EncodeToString(body)
	mac := hmac.New(sha256.New, []byte(testSecret))
	mac.Write([]byte(encoded))
	return encoded + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func testSignedURL(host, bucket, region, signature string, now time.Time) string {
	u := &url.URL{Scheme: "https", Host: host, Path: "/" + bucket + "/" + testKey}
	q := u.Query()
	q.Set("X-Amz-Algorithm", "AWS4-HMAC-SHA256")
	q.Set("X-Amz-Credential", "test-key/"+now.UTC().Format("20060102")+"/"+region+"/s3/aws4_request")
	q.Set("X-Amz-Date", now.UTC().Format("20060102T150405Z"))
	q.Set("X-Amz-Expires", "60")
	q.Set("X-Amz-SignedHeaders", "host")
	q.Set("X-Amz-Signature", strings.Repeat(signature, 64))
	u.RawQuery = q.Encode()
	return u.String()
}

func sealSource(source signedSource) string {
	plaintext, _ := json.Marshal(source)
	return sealRawSource(plaintext)
}

func sealRawSource(plaintext []byte) string {
	key := sha256.Sum256([]byte("tuckbox-download-source/v1:" + testSecret))
	block, _ := aes.NewCipher(key[:])
	aead, _ := cipher.NewGCM(block)
	nonce := []byte("123456789012")
	sealed := aead.Seal(nil, nonce, plaintext, nil)
	return base64.RawURLEncoding.EncodeToString(nonce) + "." + base64.RawURLEncoding.EncodeToString(sealed)
}

func testNode(reply transportFunc) (*server, claims) {
	now := time.Unix(1800000000, 0)
	node := &server{secret: []byte(testSecret), domain: "download.example.com", hostname: "download.example.com",
		httpClient: &http.Client{Transport: reply}, now: func() time.Time { return now }}
	source := signedSource{
		Get: testSignedURL("s3.us-west-004.backblazeb2.com", "private-backups", "us-west-004", "a", now),
		Head: testSignedURL("s3.us-west-004.backblazeb2.com", "private-backups", "us-west-004", "b", now),
	}
	c := claims{Scope: tokenScope, StorageID: "b2-primary", Key: testKey,
		Filename: "sample final.zip", MIME: "application/zip", Size: 6,
		Audience: "download.example.com", Exp: now.Add(60 * time.Second).UnixMilli(),
		Source: sealSource(source)}
	return node, c
}

func upstream(status int, content string, headers http.Header) *http.Response {
	if headers == nil {
		headers = make(http.Header)
	}
	return &http.Response{StatusCode: status, ContentLength: int64(len(content)),
		Body: io.NopCloser(strings.NewReader(content)), Header: headers}
}

func call(s *server, method, token, byteRange string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "https://download.example.com/v1/download?token="+token, nil)
	if byteRange != "" {
		req.Header.Set("Range", byteRange)
	}
	rec := httptest.NewRecorder()
	s.routes().ServeHTTP(rec, req)
	return rec
}

func TestStrictGrantJSONAndCanonicalObjectKeys(t *testing.T) {
	node, c := testNode(func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid grant must not reach storage")
		return nil, nil
	})
	if !validObjectKey(testKey) || !validObjectKey(testKey[:8]+strings.ToUpper(testKey[8:])) ||
		!validObjectKey("files/0123456789ABCDEF") {
		t.Fatal("valid canonical or legacy object key rejected")
	}
	for _, invalid := range []string{
		"tuckbox/3d4071e7a4b34c06980161f4aca13052",
		"tuckbox/{3d4071e7-a4b3-4c06-9801-61f4aca13052}",
		"tuckbox/3d4071e7-a4b3-7c06-9801-61f4aca13052",
		"tuckbox/3d4071e7-a4b3-4c06-7801-61f4aca13052",
		"files/too-short",
		"outside/3d4071e7-a4b3-4c06-9801-61f4aca13052",
	} {
		if validObjectKey(invalid) {
			t.Errorf("invalid object key accepted: %q", invalid)
		}
	}
	valid, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	prefix := string(valid[:len(valid)-1])
	for _, body := range [][]byte{
		[]byte(prefix + `,"exp":123}`),
		[]byte(prefix + `,"unknown":"x"}`),
		append([]byte(prefix+`,"unknown":"`), []byte{0xff, '"', '}'}...),
	} {
		if _, err := verifyToken(grantPayload(body), []byte(testSecret), c.Audience, node.now()); err == nil {
			t.Error("invalid JSON grant was accepted")
		}
	}
}

func TestStrictEncryptedSourceJSON(t *testing.T) {
	source := signedSource{Get: "https://get.example.com", Head: "https://head.example.com"}
	if _, err := decryptSource(sealSource(source), []byte(testSecret)); err != nil {
		t.Fatalf("valid encrypted source rejected: %v", err)
	}
	for _, raw := range [][]byte{
		[]byte(`{"get":"https://get.example.com","head":"https://head.example.com","get":"https://duplicate.example.com"}`),
		[]byte(`{"get":"https://get.example.com","head":"https://head.example.com","unknown":1}`),
		[]byte{'{', '"', 'g', 'e', 't', '"', ':', '"', 0xff, '"', '}'},
	} {
		if _, err := decryptSource(sealRawSource(raw), []byte(testSecret)); err == nil {
			t.Error("invalid encrypted source JSON was accepted")
		}
	}
}

func TestDownloadAndRanges(t *testing.T) {
	calls := 0
	node, c := testNode(func(req *http.Request) (*http.Response, error) {
		calls++
		if req.URL.Host != "s3.us-west-004.backblazeb2.com" ||
			req.URL.Path != "/private-backups/"+testKey {
			t.Fatalf("invalid S3 destination: %s", req.URL.Host)
		}
		if req.Header.Get("Authorization") != "" || req.URL.Query().Get("X-Amz-SignedHeaders") != "host" {
			t.Fatal("node must use a presigned URL without bucket credentials")
		}
		if req.Header.Get("Accept-Encoding") != "identity" {
			t.Fatal("storage response must not be transparently compressed")
		}
		if req.Method == "HEAD" {
			if req.URL.Query().Get("X-Amz-Signature") != strings.Repeat("b", 64) {
				t.Fatal("HEAD must use its own signature")
			}
			resp := upstream(200, "", nil)
			resp.ContentLength = 6
			return resp, nil
		}
		if req.URL.Query().Get("X-Amz-Signature") != strings.Repeat("a", 64) {
			t.Fatal("GET must use its own signature")
		}
		if req.Header.Get("Range") == "bytes=1-3" {
			return upstream(206, "amp", http.Header{"Content-Range": []string{"bytes 1-3/6"}}), nil
		}
		return upstream(200, "sample", nil), nil
	})
	token := grant(c)
	full := call(node, "GET", token, "")
	if full.Code != 200 || full.Body.String() != "sample" {
		t.Fatalf("full download: %d %q", full.Code, full.Body.String())
	}
	if !strings.Contains(full.Header().Get("Content-Disposition"), "sample%20final.zip") {
		t.Fatalf("filename is not RFC5987 encoded: %s", full.Header().Get("Content-Disposition"))
	}
	part := call(node, "GET", token, "bytes=1-3")
	if part.Code != 206 || part.Body.String() != "amp" || part.Header().Get("Content-Range") != "bytes 1-3/6" {
		t.Fatalf("partial download: %d %q", part.Code, part.Body.String())
	}
	head := call(node, "HEAD", token, "")
	if head.Code != 200 || head.Body.Len() != 0 || head.Header().Get("Content-Length") != "6" {
		t.Fatalf("HEAD download: %d", head.Code)
	}
	bad := call(node, "GET", token, "bytes=3-2")
	if bad.Code != 416 || bad.Header().Get("Content-Range") != "bytes */6" {
		t.Fatalf("invalid range: %d", bad.Code)
	}
	if calls != 3 {
		t.Fatalf("expected 3 bucket calls, got %d", calls)
	}
}

func TestRejectUnauthorizedDownloads(t *testing.T) {
	calls := 0
	node, c := testNode(func(*http.Request) (*http.Response, error) {
		calls++
		return upstream(200, "sample", nil), nil
	})
	token := grant(c)
	for _, invalid := range []string{
		token + "x", "bad",
		grant(func() claims { v := c; v.Scope = "admin"; return v }()),
		grant(func() claims { v := c; v.Key = "../secret"; return v }()),
		grant(func() claims { v := c; v.Exp = node.now().Add(-time.Second).UnixMilli(); return v }()),
		grant(func() claims { v := c; v.Exp = node.now().Add(time.Hour).UnixMilli(); return v }()),
		grant(func() claims { v := c; v.Audience = "other.example.com"; return v }()),
		grant(func() claims { v := c; v.Source = ""; return v }()),
		grant(func() claims { v := c; v.Source += "tampered"; return v }()),
		grant(func() claims { v := c; v.StorageID = "invalid/ID"; return v }()),
	} {
		if code := call(node, "GET", invalid, "").Code; code != 403 {
			t.Errorf("expected 403, got %d", code)
		}
	}
	if calls != 0 {
		t.Fatal("unauthorized request reached bucket")
	}
}

func TestRejectUnsafeSignedSources(t *testing.T) {
	calls := 0
	node, c := testNode(func(*http.Request) (*http.Response, error) {
		calls++
		return upstream(200, "sample", nil), nil
	})
	valid := testSignedURL("s3.us-west-004.backblazeb2.com", "private-backups", "us-west-004", "a", node.now())
	for _, sourceURL := range []string{
		strings.Replace(valid, "https://", "http://", 1),
		strings.Replace(valid, "backblazeb2.com", "example.com", 1),
		strings.Replace(valid, "s3.us-west-004", "s3.us-west-004.evil", 1),
		strings.Replace(valid, "private-backups", "another-bucket", 1) + "/wrong",
		strings.Replace(valid, "/private-backups/"+testKey, "/private-backups/tuckbox/other", 1),
		strings.Replace(valid, "X-Amz-Expires=60", "X-Amz-Expires=3600", 1),
		strings.Replace(valid, "X-Amz-SignedHeaders=host", "X-Amz-SignedHeaders=host%3Brange", 1),
		strings.Replace(valid, "https://", "https://user:pass@", 1),
		strings.Replace(valid, "backblazeb2.com/", "backblazeb2.com:8443/", 1),
	} {
		bad := c
		bad.Source = sealSource(signedSource{Get: sourceURL, Head: sourceURL})
		if code := call(node, "GET", grant(bad), "").Code; code != 403 {
			t.Errorf("unsafe source was accepted with status %d", code)
		}
	}
	if calls != 0 {
		t.Fatal("unsafe request reached bucket")
	}
}

func TestS3ResponseIntegrityAndNetworkFailure(t *testing.T) {
	node, c := testNode(func(*http.Request) (*http.Response, error) {
		return upstream(206, "amp", http.Header{"Content-Range": []string{"bytes 2-4/6"}}), nil
	})
	if code := call(node, "GET", grant(c), "bytes=1-3").Code; code != 502 {
		t.Errorf("mismatched S3 content range: %d", code)
	}
	node.httpClient.Transport = transportFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("storage network failure")
	})
	if code := call(node, "GET", grant(c), "").Code; code != 502 {
		t.Errorf("network failure: %d", code)
	}
}

func TestRangeValidationAndSignedBackends(t *testing.T) {
	for _, raw := range []string{"bytes=6-8", "bytes=1-0", "bytes=0-1,3-4",
		"items=0-2", "bytes=-0", "bytes=999999999999999999999999-"} {
		if _, _, _, err := parseRange(raw, 6); err == nil {
			t.Errorf("accepted %q", raw)
		}
	}
	for _, tt := range []struct{ in, want string }{
		{"bytes=-2", "bytes 4-5/6"}, {"bytes=4-", "bytes 4-5/6"}, {"bytes=1-999", "bytes 1-5/6"},
	} {
		_, got, _, err := parseRange(tt.in, 6)
		if err != nil || got != tt.want {
			t.Errorf("%q: %q, %v", tt.in, got, err)
		}
	}
	now := time.Unix(1800000000, 0)
	for _, tt := range []struct{ host, region string }{
		{"s3.us-west-004.backblazeb2.com", "us-west-004"},
		{strings.Repeat("a", 32) + ".r2.cloudflarestorage.com", "auto"},
		{"s3.eu-west-1.amazonaws.com", "eu-west-1"},
	} {
		signed := testSignedURL(tt.host, "private-backups", tt.region, "a", now)
		if _, err := validateSignedURL(signed, testKey, now.Add(60*time.Second).UnixMilli(), now); err != nil {
			t.Errorf("rejected signed %s endpoint: %v", tt.region, err)
		}
	}
}

func TestLoadServerWithoutBucketCredentials(t *testing.T) {
	t.Setenv("DOWNLOAD_NODE_SECRET", testSecret)
	t.Setenv("NODE_DOMAIN", "download.example.com")
	certFile, keyFile, _ := testCertificateFiles(t, "download.example.com")
	t.Setenv("TLS_CERT_FILE", certFile)
	t.Setenv("TLS_KEY_FILE", keyFile)
	t.Setenv("STORAGES_JSON", "no bucket credentials are configured")
	node, err := loadServer()
	if err != nil || node == nil {
		t.Fatalf("node must start without bucket credentials: %v", err)
	}
}
