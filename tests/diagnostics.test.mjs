import assert from "node:assert/strict";
import { test } from "node:test";
import { collectDiagnosticSecrets, redactInvocation, redactKnownSecrets, sanitizeDiagnosticText } from "../dist/server/diagnostics.js";

test("credential discovery separates public operational settings from credential fields", () => {
  const settings = { MAX_TOKENS: "2048", maxTokens: "1", maxOutputTokens: "2", tokenCount: "3", tokenBudget: "4", TEMPERATURE: "0.7", topP: "0.9", topK: "10", seed: "42", tokenizer: "ordinary text", apiKeyCount: "5", secretary: "ordinary role", credentialCount: "6" };
  assert.deepEqual(collectDiagnosticSecrets(settings), []);
  assert.equal(redactKnownSecrets("2048 1 2 3 4 0.7 0.9 10 42", collectDiagnosticSecrets(settings)), "2048 1 2 3 4 0.7 0.9 10 42");
});

test("explicit credential classes and vendor-prefixed names remain protected", () => {
  const credentials = { API_KEY: "model-secret", authToken: "run-secret", APIKey: "alias-secret", GITHUB_TOKEN: "github-value", AWS_SESSION_TOKEN: "session-value", PRIVATE_SECRET: "private-value", DB_PASSWORD: "password-value", clientSecret: "client-value", nested: { Authorization: "bearer-value", Cookie: "cookie-value", privateKey: "signing-value" } };
  const secrets = collectDiagnosticSecrets(credentials);
  for (const value of ["model-secret", "run-secret", "alias-secret", "github-value", "session-value", "private-value", "password-value", "client-value", "bearer-value", "cookie-value", "signing-value"]) assert.ok(secrets.includes(value));
});

test("actual numeric credentials stay protected without classifying numeric settings as secrets", () => {
  assert.deepEqual(collectDiagnosticSecrets({ API_KEY: "1", MAX_TOKENS: "2048", temperature: "0.7" }), ["1"]);
});

test("labeled provider diagnostics use the same credential classification policy", () => {
  const text = "max_tokens=2048, tokenCount=1; temperature=0.7";
  assert.equal(sanitizeDiagnosticText(text, []), text);
  assert.ok(!sanitizeDiagnosticText("access_token=unknown-secret", []).includes("unknown-secret"));
  assert.ok(!sanitizeDiagnosticText("X-Secret-Header: opaque-secret", []).includes("opaque-secret"));
  assert.ok(!sanitizeDiagnosticText("context: nested X-Secret-Header: opaque secret value", []).includes("opaque"));
});

test("metadata redaction covers nested object keys and values", () => {
  const value = JSON.parse('{"run-secret":{"model-secret":["run-secret"]},"__proto__":{"model-secret":"run-secret"}}');
  const safe = redactInvocation(value, ["model-secret", "run-secret"]);
  assert.ok(!/model-secret|run-secret/.test(JSON.stringify(safe)));
  assert.equal(Object.getPrototypeOf(safe), Object.prototype);
  assert.equal(Object.prototype.polluted, undefined);
});
