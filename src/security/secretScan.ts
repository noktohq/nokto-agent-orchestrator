/**
 * Hemmelighetsdeteksjon og -redigering.
 *
 * Brukes to steder:
 *  1. Før noe skrives til auditloggen eller stdout — redact() fjerner
 *     verdien og beholder kun et kort prefiks
 *     (token-prefiks maks, aldri full verdi).
 *  2. Før en gren tilbys som pull request — scanForSecrets() kjøres mot
 *     `git diff` og blokkerer PR-opprettelse dersom noe treffer.
 */

interface SecretPattern {
  name: string;
  pattern: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'github-token', pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'shopify-token', pattern: /shp(?:at|ca|ss)_[A-Za-z0-9]{20,}/g },
  { name: 'openai-key', pattern: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'anthropic-key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'google-api-key', pattern: /AIza[0-9A-Za-z_-]{35}/g },
  { name: 'aws-access-key-id', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'slack-token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  {
    name: 'private-key-block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: 'generic-assigned-secret',
    pattern:
      /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)\s*[:=]\s*["']?([A-Za-z0-9/+_.=-]{16,})["']?/g,
  },
];

export interface SecretMatch {
  patternName: string;
  preview: string;
}

export function scanForSecrets(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const value = m[2] ?? m[0];
      matches.push({ patternName: name, preview: prefixOnly(value) });
      if (m[0].length === 0) pattern.lastIndex++;
    }
  }
  return matches;
}

export function containsSecret(text: string): boolean {
  return scanForSecrets(text).length > 0;
}

function prefixOnly(value: string): string {
  const prefix = value.slice(0, 8);
  return `${prefix}...`;
}

/** Erstatter alle funnede hemmeligheter med et redigert, ikke-reverserbart merke. */
export function redact(text: string): string {
  let out = text;
  for (const { pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, (full, ...groups: unknown[]) => {
      const secretGroup = typeof groups[1] === 'string' ? groups[1] : full;
      return full.replace(secretGroup as string, `${prefixOnly(secretGroup as string)}[REDACTED]`);
    });
  }
  return out;
}
