package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
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
	encoded := base64.RawURLEncoding.EncodeToString(body)
	mac := hmac.New(sha256.New, []byte(testSecret))
	mac.Write([]byte(encoded))
	return encoded + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
func testStore() storageConfig {
	return storageConfig{ID:"b2-primary", Backend:"b2", Bucket:"private-backups", Region:"us-west-004",
		KeyID:"test-key", ApplicationKey:"test-secret"}
}
func testNode(reply transportFunc) (*server, claims) {
	now := time.Unix(1800000000, 0)
	storage := testStore()
	node := &server{secret:[]byte(testSecret), storages:map[string]storageConfig{storage.ID:storage},
		httpClient:&http.Client{Transport:reply}, now:func() time.Time{return now}}
	c := claims{Scope:tokenScope, StorageID:storage.ID, Key:testKey,
		Filename:"下载 final.zip", MIME:"application/zip", Size:6,
		Audience:"download.example.com", Exp:now.Add(60*time.Second).UnixMilli()}
	return node,c
}
func upstream(status int, content string, headers http.Header) *http.Response {
	if headers==nil { headers=make(http.Header) }
	return &http.Response{StatusCode:status, ContentLength:int64(len(content)),
		Body:io.NopCloser(strings.NewReader(content)), Header:headers}
}
func call(s *server, method, token, byteRange string) *httptest.ResponseRecorder {
	req:=httptest.NewRequest(method,"https://download.example.com/v1/download?token="+token,nil)
	if byteRange!="" { req.Header.Set("Range",byteRange) }
	rec:=httptest.NewRecorder(); s.routes().ServeHTTP(rec,req);return rec
}
func TestDownloadAndRanges(t *testing.T) {
	calls:=0
	node,c:=testNode(func(req *http.Request)(*http.Response,error){
		calls++
		if req.URL.Host!="s3.us-west-004.backblazeb2.com" ||
			req.URL.Path!="/private-backups/"+testKey {
			t.Fatalf("invalid S3 destination: %s",req.URL)
		}
		if !strings.Contains(req.Header.Get("Authorization"),"AWS4-HMAC-SHA256 Credential=test-key/") {
			t.Fatal("unsigned storage request")
		}
		if req.Method=="HEAD" {
			resp:=upstream(200,"",nil);resp.ContentLength=6;return resp,nil
		}
		if req.Header.Get("Range")=="bytes=1-3" {
			if !strings.Contains(req.Header.Get("Authorization"),"SignedHeaders=host;range;") {
				t.Fatal("range must be signed")
			}
			return upstream(206,"amp",http.Header{"Content-Range":[]string{"bytes 1-3/6"}}),nil
		}
		return upstream(200,"sample",nil),nil
	})
	token:=grant(c)
	full:=call(node,"GET",token,"")
	if full.Code!=200 || full.Body.String()!="sample" { t.Fatalf("full download: %d %q",full.Code,full.Body.String()) }
	if !strings.Contains(full.Header().Get("Content-Disposition"),"%E4%B8%8B%E8%BD%BD") {
		t.Fatalf("filename is not RFC5987 encoded: %s",full.Header().Get("Content-Disposition"))
	}
	part:=call(node,"GET",token,"bytes=1-3")
	if part.Code!=206 || part.Body.String()!="amp" || part.Header().Get("Content-Range")!="bytes 1-3/6" {
		t.Fatalf("partial download: %d %q",part.Code,part.Body.String())
	}
	head:=call(node,"HEAD",token,"")
	if head.Code!=200 || head.Body.Len()!=0 || head.Header().Get("Content-Length")!="6" {
		t.Fatalf("HEAD download: %d",head.Code)
	}
	bad:=call(node,"GET",token,"bytes=3-2")
	if bad.Code!=416 || bad.Header().Get("Content-Range")!="bytes */6" {
		t.Fatalf("invalid range: %d",bad.Code)
	}
	if calls!=3 { t.Fatalf("expected 3 bucket calls, got %d",calls) }
}

func TestRejectUnauthorizedDownloads(t *testing.T) {
	calls:=0
	node,c:=testNode(func(*http.Request)(*http.Response,error){
		calls++;return upstream(200,"sample",nil),nil
	})
	token:=grant(c)
	for _,invalid:=range []string{
		token+"x", "bad",
		grant(func() claims { v:=c;v.Scope="admin";return v }()),
		grant(func() claims { v:=c;v.Key="../secret";return v }()),
		grant(func() claims { v:=c;v.Exp=node.now().Add(-time.Second).UnixMilli();return v }()),
		grant(func() claims { v:=c;v.Exp=node.now().Add(time.Hour).UnixMilli();return v }()),
		grant(func() claims { v:=c;v.Audience="other.example.com";return v }()),
	} {
		if code:=call(node,"GET",invalid,"").Code;code!=403 { t.Errorf("expected 403, got %d",code) }
	}
	c.StorageID="other-storage"
	if code:=call(node,"GET",grant(c),"").Code;code!=503 { t.Errorf("unknown storage returned %d",code) }
	if calls!=0 { t.Fatal("unauthorized request reached bucket") }
}

func TestS3ResponseIntegrityAndNetworkFailure(t *testing.T) {
	node,c:=testNode(func(*http.Request)(*http.Response,error){
		return upstream(206,"amp",http.Header{"Content-Range":[]string{"bytes 2-4/6"}}),nil
	})
	if code:=call(node,"GET",grant(c),"bytes=1-3").Code;code!=502 {
		t.Errorf("mismatched S3 content range: %d",code)
	}
	node.httpClient.Transport=transportFunc(func(*http.Request)(*http.Response,error) {
		return nil,errors.New("storage network failure")
	})
	if code:=call(node,"GET",grant(c),"").Code;code!=502 {
		t.Errorf("network failure: %d",code)
	}
}

func TestRangeValidationAndS3Backends(t *testing.T) {
	for _,raw:=range []string{"bytes=6-8","bytes=1-0","bytes=0-1,3-4",
		"items=0-2","bytes=-0","bytes=999999999999999999999999-"} {
		if _,_,_,err:=parseRange(raw,6);err==nil { t.Errorf("accepted %q",raw) }
	}
	for _,tt:=range []struct{in,want string}{
		{"bytes=-2","bytes 4-5/6"}, {"bytes=4-","bytes 4-5/6"}, {"bytes=1-999","bytes 1-5/6"},
	} {
		_,got,_,err:=parseRange(tt.in,6)
		if err!=nil || got!=tt.want { t.Errorf("%q: %q, %v",tt.in,got,err) }
	}
	for _,tt:=range []struct{s storageConfig;host,region string}{
		{testStore(),"s3.us-west-004.backblazeb2.com","us-west-004"},
		{storageConfig{ID:"r2-node",Backend:"r2",Bucket:"uploads",
			AccountID:strings.Repeat("a",32),AccessKeyID:"r2-key",SecretAccessKey:"r2-secret"},
			strings.Repeat("a",32)+".r2.cloudflarestorage.com","auto"},
		{storageConfig{ID:"aws-node",Backend:"s3",Bucket:"objects",
			Region:"eu-west-1",AccessKeyID:"aws-key",SecretAccessKey:"aws-secret"},
			"s3.eu-west-1.amazonaws.com","eu-west-1"},
	} {
		req,err:=signS3Request("GET",tt.s,testKey,"",time.Unix(1800000000,0))
		if err!=nil || req.URL.Host!=tt.host ||
			!strings.Contains(req.Header.Get("Authorization"),"/"+tt.region+"/s3/aws4_request") {
			t.Errorf("bad SigV4 backend: %s (%v)",tt.s.Backend,err)
		}
	}
}
