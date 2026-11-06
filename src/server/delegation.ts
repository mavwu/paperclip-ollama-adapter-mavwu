import { createHash, randomUUID } from "node:crypto";
import type { ServiceClients } from "./http.js";
import type { ExecutionControl } from "./lifecycle.js";
import { executionError, executionErrorCode } from "./lifecycle.js";
import { describeError, errorHttpStatus, redactKnownSecrets } from "./diagnostics.js";

export const ACTION_DOCUMENT = "ollama-delegation-v1";
export const RECEIPT_DOCUMENT = "ollama-delegation-receipt-v1";
type Action = Record<string, unknown>;
type Payload = { title: string; description: string; status: "todo"; parentId: string; assigneeAgentId: string; idempotencyKey: string };
type Scope = { storage: string; companyId?: string | null; sourceIssueId?: string | null; agentId?: string; runId?: string; request?: string; serviceIdentity?: string };
type Reservation = { version: 1; actionKey: string; companyId: string; sourceIssueId: string; agentId: string; requestHash: string; payloadHash: string; createdAt: string; nonce: string; payload: Payload };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function own(value: unknown, key: string): unknown {
  try { return value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined; } catch { return undefined; }
}
export interface CreationMetadata {
  creationOutcome: "created" | "reused" | "unknown";
  deduplicationReason?: "idempotency_key" | "recent_open_title";
}
function deduplicationReason(value: unknown): value is NonNullable<CreationMetadata["deduplicationReason"]> {
  return value === "idempotency_key" || value === "recent_open_title";
}
// Pinned Paperclip returns 201 for creation and 200 + deduplicated:true for
// reuse. Legacy 200 receipts without diagnostics establish neither distinction.
export function readCreationMetadata(status: number, data: unknown): CreationMetadata | undefined {
  const flag = own(data, "deduplicated"), reason = own(data, "deduplicationReason");
  if (flag !== undefined && typeof flag !== "boolean") return undefined;
  if (reason != null && !deduplicationReason(reason)) return undefined;
  if (status === 201 && flag !== true && reason == null) return { creationOutcome: "created" };
  if (status !== 200) return undefined;
  if (flag === true) return { creationOutcome: "reused", ...(deduplicationReason(reason) ? { deduplicationReason: reason } : {}) };
  return reason == null ? { creationOutcome: "unknown" } : undefined;
}
function storedCreationMetadata(value: unknown): CreationMetadata | undefined {
  const outcome = own(value, "creationOutcome"), reason = own(value, "deduplicationReason");
  if (outcome === undefined && reason === undefined) return { creationOutcome: "unknown" }; // Existing v1 receipts.
  if (outcome !== "created" && outcome !== "reused" && outcome !== "unknown") return undefined;
  if (reason !== undefined && (outcome !== "reused" || !deduplicationReason(reason))) return undefined;
  return { creationOutcome: outcome, ...(deduplicationReason(reason) ? { deduplicationReason: reason } : {}) };
}
function text(value: unknown, max: number, secrets: readonly string[]): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value === value.trim() &&
    !/[<>\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value) && redactKnownSecrets(value, secrets) === value;
}
function description(value: unknown, secrets: readonly string[]): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 32_000 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value) && redactKnownSecrets(value, secrets) === value;
}
function blocked(reason: string, persistence = "not_attempted", detail?: string): Action {
  return { type: "delegate_issue", attempted: false, success: false, persistence, reason,
    error: detail ?? "Delegation is blocked. Inspect the source issue and its delegation safety records; no issue-creation request was started." };
}
function documentBody(data: unknown, key: string, scope: Scope, secrets: readonly string[]): Record<string, unknown> {
  // A locked document may redirect a PUT to a different key. Never accept it as
  // the reservation: only the unique fixed key excludes another creator.
  if (own(data, "key") !== key || own(data, "issueId") !== scope.sourceIssueId || own(data, "companyId") !== scope.companyId ||
      own(data, "format") !== "markdown" || own(data, "lockedAt") != null || !text(own(data, "latestRevisionId"), 128, secrets)) throw new Error("Invalid delegation document receipt.");
  const body = own(data, "body");
  if (typeof body !== "string" || body.length > 65_536) throw new Error("Invalid delegation document body.");
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid delegation document body.");
  return parsed as Record<string, unknown>;
}

export interface DelegationJournal {
  reserve(title: string, description: string, assigneeAgentId: string): Promise<{ payload?: Payload; action?: Action }>;
  record(action: Action): Promise<Action>;
}

// One immutable reservation per source issue. We never POST from a reservation
// recovered by another invocation, even inside the server's retention window.
// This deliberately trades availability for safety at every crash boundary.
export async function openDelegation(scope: Scope, clients: ServiceClients, secrets: readonly string[], control: ExecutionControl): Promise<{ journal?: DelegationJournal; action?: Action }> {
  if (scope.storage !== "paperclip_documents_v1") return { action: blocked("durable_storage_required") };
  const { companyId, sourceIssueId, agentId, runId } = scope;
  if (![companyId, sourceIssueId, agentId, runId].every(value => text(value, 128, secrets)) || typeof scope.request !== "string" || !scope.serviceIdentity) return { action: blocked("invalid_action_scope") };
  const company = companyId!, source = sourceIssueId!, agent = agentId!, run = runId!;
  const actionKey = `ollama-delegation-v1:${hash([scope.serviceIdentity, company, source])}`;
  const requestHash = hash(scope.request);
  let reservation: Reservation | undefined;
  let mutationRestricted = false;
  async function ownership(mutation = true) {
    control.check();
    const data = (await clients.getIssue(source)).data;
    control.check();
    // Admission belongs to Paperclip. We neither acquire nor adopt a checkout.
    // Require a current execution owner; null checkout is allowed for host-only
    // admission, but a different checkout (or missing ownership fields) is not.
    if (own(data, "id") !== source || own(data, "companyId") !== company || own(data, "assigneeAgentId") !== agent ||
        own(data, "status") !== "in_progress" || own(data, "workMode") !== "standard" ||
        own(data, "executionRunId") !== run || (own(data, "checkoutRunId") !== null && own(data, "checkoutRunId") !== run)) throw new Error("Source issue ownership or work mode is not eligible for delegation.");
    const self = (await clients.getSelf()).data;
    control.check();
    if (own(self, "id") !== agent || own(self, "companyId") !== company || !["idle", "active", "running"].includes(own(self, "status") as string) ||
        own(self, "keyScope") != null) throw new Error("Authenticated agent identity is not eligible for delegation.");
    const activeRun = (await clients.getRun(run)).data;
    control.check();
    if (own(activeRun, "id") !== run || own(activeRun, "companyId") !== company || own(activeRun, "agentId") !== agent ||
        own(activeRun, "status") !== "running" || own(activeRun, "scopeKind") !== "issue" || own(activeRun, "issueId") !== source) throw new Error("The authenticated execution is not an active run for this source issue.");
    const snapshot = own(activeRun, "contextSnapshot");
    mutationRestricted = own(snapshot, "recoveryIntent") === "status_only" || own(snapshot, "allowDeliverableWork") === false || own(snapshot, "allowDocumentUpdates") === false;
    if (mutation && mutationRestricted) throw new Error("This recovery run does not permit delegation or journal mutations.");
  }
  function readReservation(data: unknown): Reservation {
    const value = documentBody(data, ACTION_DOCUMENT, scope, secrets);
    const raw = own(value, "payload");
    const payload: Payload = {
      title: own(raw, "title") as string, description: own(raw, "description") as string, status: "todo",
      parentId: source, assigneeAgentId: own(raw, "assigneeAgentId") as string, idempotencyKey: actionKey,
    };
    if (value.version !== 1 || value.companyId !== company || value.sourceIssueId !== source || value.agentId !== agent || value.actionKey !== actionKey ||
        value.requestHash !== requestHash || !text(payload.title, 240, secrets) || !description(payload.description, secrets) || !text(payload.assigneeAgentId, 128, secrets) || payload.assigneeAgentId === agent ||
        own(raw, "status") !== "todo" || own(raw, "parentId") !== source || own(raw, "idempotencyKey") !== actionKey ||
        value.payloadHash !== hash(payload) || !text(value.nonce, 128, secrets) || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) throw new Error("Delegation reservation does not match this request and scope.");
    return { version: 1, companyId: company, sourceIssueId: source, agentId: agent, actionKey, requestHash, payloadHash: hash(payload),
      createdAt: value.createdAt, nonce: value.nonce, payload };
  }
  async function verifyChild(issueId: string, payload: Payload) {
    const child = (await clients.getIssue(issueId)).data;
    control.check();
    if (own(child, "id") !== issueId || own(child, "companyId") !== company || own(child, "assigneeAgentId") !== payload.assigneeAgentId ||
        (own(child, "parentId") !== source && own(child, "privacyParentIssueId") !== source) ||
        own(child, "title") !== payload.title || own(child, "description") !== payload.description) throw new Error("The existing issue does not match the immutable delegation payload.");
  }
  function readReceipt(data: unknown) {
    const value = documentBody(data, RECEIPT_DOCUMENT, scope, secrets);
    const metadata = storedCreationMetadata(value);
    if (value.version !== 1 || value.actionKey !== actionKey || typeof value.payloadHash !== "string" || !/^[a-f0-9]{64}$/.test(value.payloadHash) ||
        !text(value.issueId, 128, secrets) || value.issueId === source || !metadata) throw new Error("Invalid stored delegation receipt.");
    return { issueId: value.issueId, payloadHash: value.payloadHash, ...metadata };
  }
  try {
    await ownership(false);
    let existing;
    try { existing = await clients.getDocument(source, ACTION_DOCUMENT); }
    catch (error) { if (errorHttpStatus(error) !== 404) throw error; }
    // Both keys must be verifiably absent before planning a fresh reservation.
    // A surviving receipt is contradictory evidence, never permission to POST.
    let receipt;
    try { receipt = await clients.getDocument(source, RECEIPT_DOCUMENT); }
    catch (error) { if (errorHttpStatus(error) !== 404) throw error; }
    if (!existing && receipt) {
      try {
        const value = readReceipt(receipt.data);
        return { action: { ...blocked("orphan_receipt_requires_reconciliation", "unknown"), issueId: value.issueId, receiptVerified: false,
          creationOutcome: value.creationOutcome, ...(value.deduplicationReason ? { deduplicationReason: value.deduplicationReason } : {}) } };
      } catch {
        return { action: blocked("invalid_orphan_receipt", "unknown") };
      }
    }
    if (existing) {
      reservation = readReservation(existing.data);
      // Absence of a receipt is NOT absence of an issue, even for a recent key.
      if (!receipt) {
        const expired = Date.now() - Date.parse(reservation.createdAt) >= 7 * 24 * 60 * 60 * 1000;
        return { action: blocked(expired ? "expired_unresolved_action" : "unresolved_action", "unknown") };
      }
      const value = readReceipt(receipt.data);
      if (value.payloadHash !== reservation.payloadHash) throw new Error("Stored receipt does not match the delegation payload.");
      const issueId = value.issueId;
      try {
        await verifyChild(issueId, reservation.payload);
      } catch (error) {
        const stop = executionError(error);
        return { action: { ...blocked("reconciliation_failed", "unknown", describeError(error, secrets)), issueId, receiptVerified: false,
          creationOutcome: value.creationOutcome, ...(value.deduplicationReason ? { deduplicationReason: value.deduplicationReason } : {}), ...(stop ? { errorCode: stop.code } : {}) } };
      }
      return { action: { type: "delegate_issue", attempted: false, success: true, persistence: "confirmed", reconciled: true,
        issueId, assigneeAgentId: reservation.payload.assigneeAgentId, creationOutcome: value.creationOutcome,
        ...(value.deduplicationReason ? { deduplicationReason: value.deduplicationReason } : {}) } };
    }
    if (mutationRestricted) return { action: blocked("recovery_mutation_forbidden") };
    return { journal: {
      async reserve(title, detail, assigneeAgentId) {
        if (!text(title, 240, secrets) || !description(detail, secrets) || !text(assigneeAgentId, 128, secrets) || assigneeAgentId === agent) return { action: blocked("invalid_delegation_payload") };
        const payload: Payload = { title, description: detail, status: "todo", parentId: source, assigneeAgentId, idempotencyKey: actionKey };
        reservation = { version: 1, actionKey, companyId: company, sourceIssueId: source, agentId: agent, requestHash,
          payloadHash: hash(payload), createdAt: new Date().toISOString(), nonce: randomUUID(), payload };
        try {
          await ownership();
          const response = await clients.createDocument(source, ACTION_DOCUMENT, JSON.stringify(reservation));
          // A recovered PUT response cannot authorize a new POST after stop.
          control.check();
          if (response.interruption) throw response.interruption;
          const observed = readReservation(response.data);
          if (response.status !== 201 || observed.nonce !== reservation.nonce || observed.createdAt !== reservation.createdAt || observed.payloadHash !== reservation.payloadHash) throw new Error("The delegation reservation was not exclusively created.");
          await ownership();
          control.check();
          return { payload };
        } catch (error) {
          const stop = executionError(error) ?? executionError(own(error, "interruption"));
          return { action: { ...blocked("reservation_not_confirmed", "not_attempted", describeError(error, secrets)), ...(stop ? { errorCode: stop.code } : {}) } };
        }
      },
      async record(action) {
        if (executionErrorCode(action.errorCode)) return action;
        if (action.persistence !== "confirmed" || !text(action.issueId, 128, secrets) || !reservation) return action;
        try {
          await ownership();
          const metadata = storedCreationMetadata(action);
          if (!metadata) throw new Error("Invalid delegation creation metadata.");
          const body = { version: 1, actionKey, payloadHash: reservation.payloadHash, issueId: action.issueId, ...metadata };
          const response = await clients.createDocument(source, RECEIPT_DOCUMENT, JSON.stringify(body));
          control.check();
          if (response.interruption) throw response.interruption;
          const receipt = readReceipt(response.data);
          if (response.status !== 201 || receipt.payloadHash !== reservation.payloadHash || receipt.issueId !== action.issueId ||
              receipt.creationOutcome !== metadata.creationOutcome || receipt.deduplicationReason !== metadata.deduplicationReason) throw new Error("The delegation receipt was not durably confirmed.");
          await verifyChild(action.issueId, reservation.payload);
          return action;
        } catch (error) {
          const stop = executionError(error) ?? executionError(own(error, "interruption"));
          // Keep the creation receipt even if persistence/verification or a later
          // callback fails. Never replace a known ID with an uncertain retry.
          return { ...action, success: false, reason: action.reason ?? "receipt_requires_review", error: describeError(error, secrets), ...(stop ? { errorCode: stop.code } : {}) };
        }
      },
    } };
  } catch (error) {
    if (executionError(error)) throw error;
    return { action: blocked("ownership_or_storage_unavailable", "unknown", describeError(error, secrets)) };
  }
}
