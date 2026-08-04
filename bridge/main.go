// pi-meat-bridge adapts Meat's provider-neutral Model interface to a JSONL
// client. The Pi extension owns the actual model call, so credentials and
// subscription tokens never leave Pi's process.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"

	"meat.dev/meat"
)

const protocolVersion = 1

type block struct {
	Type         string          `json:"type"`
	Text         string          `json:"text,omitempty"`
	ID           string          `json:"id,omitempty"`
	ToolName     string          `json:"tool_name,omitempty"`
	ToolInput    json.RawMessage `json:"tool_input,omitempty"`
	ToolUseID    string          `json:"tool_use_id,omitempty"`
	ToolResult   string          `json:"tool_result,omitempty"`
	ToolError    bool            `json:"tool_error,omitempty"`
	Provider     string          `json:"provider,omitempty"`
	ProviderData json.RawMessage `json:"provider_data,omitempty"`
}

type message struct {
	Role    string  `json:"role"`
	Content []block `json:"content"`
}

type tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"input_schema"`
}

type startRequest struct {
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocol_version"`
	RepoRoot        string `json:"repo_root"`
	Diff            string `json:"diff"`
	MaxTurns        int    `json:"max_turns,omitempty"`
}

type generateRequest struct {
	Type     string    `json:"type"`
	ID       int       `json:"id"`
	System   string    `json:"system"`
	Messages []message `json:"messages"`
	Tools    []tool    `json:"tools"`
}

type generateResponse struct {
	Type         string  `json:"type"`
	ID           int     `json:"id"`
	Content      []block `json:"content"`
	InputTokens  int     `json:"input_tokens"`
	OutputTokens int     `json:"output_tokens"`
	Error        string  `json:"error,omitempty"`
}

type event struct {
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocol_version,omitempty"`
	Message         string `json:"message,omitempty"`
	Summary         string `json:"summary,omitempty"`
	SmartDiff       string `json:"smart_diff,omitempty"`
	InputTokens     int    `json:"input_tokens,omitempty"`
	OutputTokens    int    `json:"output_tokens,omitempty"`
}

type bridgeModel struct {
	scanner *bufio.Scanner
	encoder *json.Encoder
	mu      sync.Mutex
	nextID  int
}

func (m *bridgeModel) send(v any) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.encoder.Encode(v)
}

func (m *bridgeModel) Generate(_ context.Context, system string, messagesIn []meat.Message, toolsIn []meat.Tool) (*meat.Response, error) {
	m.nextID++
	id := m.nextID
	request := generateRequest{Type: "generate", ID: id, System: system}
	for _, msg := range messagesIn {
		converted := message{Role: string(msg.Role)}
		for _, b := range msg.Content {
			converted.Content = append(converted.Content, block{
				Type: b.Type, Text: b.Text, ID: b.ID, ToolName: b.ToolName,
				ToolInput: b.ToolInput, ToolUseID: b.ToolUseID,
				ToolResult: b.ToolResult, ToolError: b.ToolError,
				Provider: b.Provider, ProviderData: b.ProviderData,
			})
		}
		request.Messages = append(request.Messages, converted)
	}
	for _, t := range toolsIn {
		request.Tools = append(request.Tools, tool{Name: t.Name, Description: t.Description, InputSchema: t.InputSchema})
	}
	if err := m.send(request); err != nil {
		return nil, fmt.Errorf("write generate request: %w", err)
	}

	if !m.scanner.Scan() {
		if err := m.scanner.Err(); err != nil {
			return nil, fmt.Errorf("read generate response: %w", err)
		}
		return nil, errors.New("model bridge closed while waiting for a response")
	}
	var response generateResponse
	if err := json.Unmarshal(m.scanner.Bytes(), &response); err != nil {
		return nil, fmt.Errorf("decode generate response: %w", err)
	}
	if response.Type != "generate_result" || response.ID != id {
		return nil, fmt.Errorf("unexpected response type/id: %q/%d, want generate_result/%d", response.Type, response.ID, id)
	}
	if response.Error != "" {
		return nil, errors.New(response.Error)
	}

	result := &meat.Response{InputTokens: response.InputTokens, OutputTokens: response.OutputTokens}
	for _, b := range response.Content {
		result.Content = append(result.Content, meat.Block{
			Type: b.Type, Text: b.Text, ID: b.ID, ToolName: b.ToolName,
			ToolInput: b.ToolInput, ToolUseID: b.ToolUseID,
			ToolResult: b.ToolResult, ToolError: b.ToolError,
			Provider: b.Provider, ProviderData: b.ProviderData,
		})
	}
	return result, nil
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64<<10), 32<<20)
	encoder := json.NewEncoder(os.Stdout)
	model := &bridgeModel{scanner: scanner, encoder: encoder}

	if !scanner.Scan() {
		fatal(encoder, "missing start request")
		return
	}
	var start startRequest
	if err := json.Unmarshal(scanner.Bytes(), &start); err != nil {
		fatal(encoder, "decode start request: "+err.Error())
		return
	}
	if start.Type != "abridge" {
		fatal(encoder, "first request must be abridge")
		return
	}
	if start.ProtocolVersion != protocolVersion {
		fatal(encoder, fmt.Sprintf("protocol mismatch: bridge=%d extension=%d", protocolVersion, start.ProtocolVersion))
		return
	}

	_ = model.send(event{Type: "ready", ProtocolVersion: protocolVersion})
	result, err := meat.Abridge(context.Background(), model, meat.Request{
		RepoRoot:    start.RepoRoot,
		UnifiedDiff: start.Diff,
		MaxTurns:    start.MaxTurns,
		Progress: func(message string) {
			_ = model.send(event{Type: "progress", Message: message})
		},
	})
	if err != nil {
		fatal(encoder, err.Error())
		return
	}
	_ = model.send(event{
		Type: "result", Summary: result.Summary, SmartDiff: result.SmartDiff,
		InputTokens: result.InputTokens, OutputTokens: result.OutputTokens,
	})
}

func fatal(encoder *json.Encoder, message string) {
	_ = encoder.Encode(event{Type: "error", Message: message})
}
