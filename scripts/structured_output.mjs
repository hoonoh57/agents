import crypto from 'node:crypto';

function sha256(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

export function parseFirstJsonObject(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { value: null, strict: false, recovered: false, trailing: 0, error: 'EMPTY_OUTPUT' };
  try {
    return { value: JSON.parse(text), strict: true, recovered: false, trailing: 0, error: null };
  } catch (strictError) {
    const start = text.indexOf('{');
    if (start < 0) return { value: null, strict: false, recovered: false, trailing: text.length, error: String(strictError?.message || strictError) };
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') quoted = false;
        continue;
      }
      if (ch === '"') { quoted = true; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            const value = JSON.parse(candidate);
            const prefix = text.slice(0, start).trim();
            const suffix = text.slice(i + 1).trim();
            return {
              value,
              strict: prefix.length === 0 && suffix.length === 0,
              recovered: true,
              trailing: prefix.length + suffix.length,
              error: null,
            };
          } catch (candidateError) {
            return { value: null, strict: false, recovered: false, trailing: text.length, error: String(candidateError?.message || candidateError) };
          }
        }
      }
    }
    return { value: null, strict: false, recovered: false, trailing: text.length, error: String(strictError?.message || strictError) };
  }
}

export function outputDiagnostic({ text, body, attempt, validationError = null }) {
  const value = String(text ?? '');
  return {
    attempt,
    doneReason: body?.done_reason ?? null,
    outputTokens: Number(body?.eval_count || 0),
    contentChars: value.length,
    contentSha256: sha256(value),
    preview: value.slice(0, 700),
    validationError,
  };
}

export function selfTestStructuredOutput() {
  const strict = parseFirstJsonObject('{"x":1}');
  const trailing = parseFirstJsonObject('```\n{"x":1}\n```');
  const incomplete = parseFirstJsonObject('{"x":');
  if (!strict.strict || strict.value?.x !== 1) throw new Error('STRUCTURED_OUTPUT_STRICT_SELF_TEST_FAILED');
  if (!trailing.recovered || trailing.strict || trailing.value?.x !== 1 || trailing.trailing === 0) throw new Error('STRUCTURED_OUTPUT_RECOVERY_SELF_TEST_FAILED');
  if (incomplete.value !== null) throw new Error('STRUCTURED_OUTPUT_INCOMPLETE_SELF_TEST_FAILED');
  return true;
}
