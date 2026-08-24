import { describe, expect, it } from "vitest";
import { REDACTED_PLACEHOLDER, redactText, redactToolResult } from "../src/redact.js";

describe("secret redaction engine", () => {
  it("redacts OpenAI API keys", () => {
    const legacy = "sk-1234567890abcdef1234567890abcdef";
    const project = "sk-proj-abcde12345FGHIJ67890klmno12345PQRST67890";
    const admin = "sk-admin-1234567890abcdef1234567890abcdef";

    expect(redactText(`key is ${legacy}`).text).toBe(`key is ${REDACTED_PLACEHOLDER}`);
    expect(redactText(`key is ${project}`).text).toBe(`key is ${REDACTED_PLACEHOLDER}`);
    expect(redactText(`key is ${admin}`).text).toBe(`key is ${REDACTED_PLACEHOLDER}`);
  });

  it("redacts Anthropic API keys", () => {
    const key = "sk-ant-api03-1234567890abcdef1234567890abcdef1234567890";
    expect(redactText(`Anthropic key: ${key}`).text).toBe(`Anthropic key: ${REDACTED_PLACEHOLDER}`);
  });

  it("redacts GitHub tokens", () => {
    const ghp = "ghp_1234567890abcdef1234567890abcdef1234";
    const gho = "gho_1234567890abcdef1234567890abcdef1234";
    const pat = "github_pat_11AAAAAAA01234567890_abcdefghijklmnopqrstuvwxyz1234567890";

    expect(redactText(`token: ${ghp}`).text).toBe(`token: ${REDACTED_PLACEHOLDER}`);
    expect(redactText(`token: ${gho}`).text).toBe(`token: ${REDACTED_PLACEHOLDER}`);
    expect(redactText(`token: ${pat}`).text).toBe(`token: ${REDACTED_PLACEHOLDER}`);
  });

  it("redacts AWS Access Key IDs", () => {
    const aws = "AKIAIOSFODNN7EXAMPLE";
    expect(redactText(`Access key ${aws}`).text).toBe(`Access key ${REDACTED_PLACEHOLDER}`);
  });

  it("redacts Private Keys in PEM format", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y3wZ...
...test...
-----END RSA PRIVATE KEY-----`;
    const result = redactText(`Content:\n${pem}\nEnd`);
    expect(result.redacted).toBe(true);
    expect(result.text).toBe(`Content:\n${REDACTED_PLACEHOLDER}\nEnd`);
  });

  it("redacts JWT tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(redactText(`Authorization: Bearer ${jwt}`).text).toBe(`Authorization: Bearer ${REDACTED_PLACEHOLDER}`);
  });

  it("redacts generic secret assignments", () => {
    const assignment = "OPENAI_API_KEY=my_super_secret_token_12345";
    expect(redactText(assignment).text).toBe(`OPENAI_API_KEY=${REDACTED_PLACEHOLDER}`);
  });

  it("does not mutate normal code, URLs, or UUIDs", () => {
    const code = `
function calculateTotal(items: number[]) {
  const url = "https://api.github.com/repos/owner/repo/pulls";
  const id = "f39997da-a6b2-4786-ac6d-2c23e5ceb869";
  return items.reduce((a, b) => a + b, 0);
}
`;
    const result = redactText(code);
    expect(result.redacted).toBe(false);
    expect(result.count).toBe(0);
    expect(result.text).toBe(code);
  });
});

describe("redactToolResult", () => {
  it("redacts content array in standard MCP CallToolResult", () => {
    const rawResult = {
      content: [
        { type: "text", text: "Found config:\nsk-proj-1234567890abcdef1234567890" },
        { type: "text", text: "Normal text without secrets." },
      ],
      isError: false,
    };

    const { result, redacted, count } = redactToolResult(rawResult);
    expect(redacted).toBe(true);
    expect(count).toBe(1);
    expect(result).toEqual({
      content: [
        { type: "text", text: `Found config:\n${REDACTED_PLACEHOLDER}` },
        { type: "text", text: "Normal text without secrets." },
      ],
      isError: false,
    });
  });

  it("handles non-object inputs safely", () => {
    expect(redactToolResult(null)).toEqual({ result: null, redacted: false, count: 0 });
    expect(redactToolResult(123)).toEqual({ result: 123, redacted: false, count: 0 });
    expect(redactToolResult("sk-proj-1234567890abcdef1234567890")).toEqual({
      result: REDACTED_PLACEHOLDER,
      redacted: true,
      count: 1,
    });
  });

  it("redacts string values stored under sensitive field names", () => {
    expect(redactToolResult({
      password: "supersecret123",
      nested: { auth_token: "opaquecredential987", label: "safe" },
    })).toEqual({
      result: {
        password: REDACTED_PLACEHOLDER,
        nested: { auth_token: REDACTED_PLACEHOLDER, label: "safe" },
      },
      redacted: true,
      count: 2,
    });
  });
});
