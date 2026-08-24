export const REDACTED_PLACEHOLDER = "[REDACTED_SECRET]";

interface SecretPattern {
  name: string;
  pattern: RegExp;
  replacer?: (substring: string, ...args: any[]) => string;
}

const secretPatterns: SecretPattern[] = [
  // Private keys (PEM / OpenSSH / PGP)
  {
    name: "private_key",
    pattern: /-----BEGIN (?:[A-Z0-9_-]+ )?(?:RSA|DSA|EC|OPENSSH|PGP)?\s*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9_-]+ )?(?:RSA|DSA|EC|OPENSSH|PGP)?\s*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  // OpenAI API keys (standard, project, admin, service account)
  {
    name: "openai_key",
    pattern: /\bsk-(?:proj-|admin-|svcacct-)?[a-zA-Z0-9_-]{20,}\b/g,
  },
  // Anthropic API keys
  {
    name: "anthropic_key",
    pattern: /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/g,
  },
  // GitHub tokens (Personal access token, OAuth, user/server tokens, fine-grained PAT)
  {
    name: "github_token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36}\b|\bgithub_pat_[a-zA-Z0-9_]{22,}\b/g,
  },
  // AWS Access Key ID
  {
    name: "aws_access_key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  // Slack tokens
  {
    name: "slack_token",
    pattern: /\bxox[baprs]-[0-9a-zA-Z-]{10,}\b/g,
  },
  // JWT tokens (Bearer or raw)
  {
    name: "jwt_token",
    pattern: /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g,
  },
  // Generic key-value secret assignments (e.g. OPENAI_API_KEY=..., secret_key: "...")
  {
    name: "generic_assignment",
    pattern: /(\b[a-zA-Z0-9_]*(?:api[_-]?key|secret[_-]?key|auth[_-]?token|private[_-]?key|access[_-]?token|password)\s*[:=]\s*['"]?)[^\s'"`,;]{8,}(['"]?)/gi,
    replacer: (_match: string, prefix: string, quote: string) => `${prefix}${REDACTED_PLACEHOLDER}${quote}`,
  },
];

const sensitiveFieldPattern = /^[a-zA-Z0-9_]*(?:api[_-]?key|secret[_-]?key|auth[_-]?token|private[_-]?key|access[_-]?token|password)$/i;

export interface RedactionResult {
  text: string;
  redacted: boolean;
  count: number;
}

export function redactText(input: string): RedactionResult {
  let text = input;
  let count = 0;

  for (const { pattern, replacer } of secretPatterns) {
    pattern.lastIndex = 0;
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      count += matches.length;
      pattern.lastIndex = 0;
      text = replacer ? text.replace(pattern, replacer) : text.replace(pattern, REDACTED_PLACEHOLDER);
    }
  }

  return {
    text,
    redacted: count > 0,
    count,
  };
}

export function redactToolResult(result: unknown): {
  result: unknown;
  redacted: boolean;
  count: number;
} {
  if (result === null || typeof result !== "object") {
    if (typeof result === "string") {
      const { text, redacted, count } = redactText(result);
      return { result: text, redacted, count };
    }
    return { result, redacted: false, count: 0 };
  }

  let totalCount = 0;

  function redactValue(value: unknown): unknown {
    if (typeof value === "string") {
      const { text, count } = redactText(value);
      totalCount += count;
      return text;
    }
    if (Array.isArray(value)) {
      return value.map(redactValue);
    }
    if (value !== null && typeof value === "object") {
      const copy: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (sensitiveFieldPattern.test(k) && typeof v === "string") {
          copy[k] = REDACTED_PLACEHOLDER;
          totalCount += 1;
        } else {
          copy[k] = redactValue(v);
        }
      }
      return copy;
    }
    return value;
  }

  const redactedResult = redactValue(result);
  return {
    result: totalCount > 0 ? redactedResult : result,
    redacted: totalCount > 0,
    count: totalCount,
  };
}
