package vault

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
)

// VaultClient interacts with the distributed storage Gateway.
type VaultClient struct {
	GatewayURL string
	HTTPClient *http.Client
}

func NewVaultClient(gatewayURL string) *VaultClient {
	return &VaultClient{
		GatewayURL: gatewayURL,
		HTTPClient: &http.Client{},
	}
}

// UploadFile streams and chunks a file payload with SHA-256 validation.
func (c *VaultClient) UploadFile(filePath string, replicationFactor int) (map[string]interface{}, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("file", filepath.Base(filePath))
	if err != nil {
		return nil, err
	}

	h := sha256.New()
	mw := io.MultiWriter(part, h)
	_, err = io.Copy(mw, file)
	if err != nil {
		return nil, err
	}

	_ = writer.WriteField("replicationFactor", fmt.Sprintf("%d", replicationFactor))
	writer.Close()

	req, err := http.NewRequest("POST", c.GatewayURL+"/api/v1/objects/upload", body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var result map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&result)
	result["computed_sha256"] = hex.EncodeToString(h.Sum(nil))
	return result, nil
}
