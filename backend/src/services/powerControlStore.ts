import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { hardwareConnections, hardwarePowerOperations, hardwarePowerPolicies } from '../db/schema/index.ts';
import { decryptSecret } from '../utils/secrets.ts';
import type { HardwareMode } from './iloAdapter.ts';
import type { PowerDecision, WritablePowerMode } from './powerPolicy.ts';
import type { ClaimOutcome, ControlRepository, ControlSnapshot } from './powerController.ts';

const WRITABLE = new Set<WritablePowerMode>(['low', 'dynamic', 'high']);

export class PowerControlStore implements ControlRepository {
  async load(hardwareId: number): Promise<ControlSnapshot | null> {
    const [joined] = await db.select({ connection: hardwareConnections, policy: hardwarePowerPolicies })
      .from(hardwareConnections)
      .innerJoin(hardwarePowerPolicies, eq(hardwareConnections.id, hardwarePowerPolicies.hardware_id))
      .where(and(eq(hardwareConnections.id, hardwareId), eq(hardwareConnections.lifecycle_state, 'active')))
      .limit(1);
    if (!joined) return null;
    const { connection, policy } = joined;
    const capabilities = connection.capabilities as { runtimeMode?: string; supportedModes?: string[] } | null;
    const supportedModes = capabilities?.runtimeMode === 'supported'
      ? (capabilities.supportedModes ?? ['low', 'dynamic', 'high']).filter((mode): mode is WritablePowerMode => WRITABLE.has(mode as WritablePowerMode))
      : [];
    const manual = policy.manual_mode && WRITABLE.has(policy.manual_mode as WritablePowerMode)
      ? { mode: policy.manual_mode as WritablePowerMode, expiresAt: policy.manual_expires_at } : null;
    return {
      hardwareId,
      configVersion: connection.config_version,
      policyVersion: policy.version,
      controlEnabled: connection.control_enabled,
      automationEnabled: policy.automation_enabled,
      paused: policy.paused,
      driftHold: policy.drift_hold,
      supportedModes,
      schedule: policy.schedule,
      pricePolicy: policy.price_policy,
      latch: policy.latch,
      manualOverride: manual,
      ilo: {
        host: connection.target_host, port: connection.target_port, username: connection.username,
        password: decryptSecret(connection.secret), verifyTls: connection.verify_tls,
        caCertificate: connection.ca_certificate,
      },
    };
  }

  async claim(snapshot: ControlSnapshot, token: string, expiresAt: Date): Promise<boolean> {
    const now = new Date();
    const rows = await db.update(hardwarePowerPolicies)
      .set({ claim_token: token, claim_expires_at: expiresAt })
      .where(and(eq(hardwarePowerPolicies.hardware_id, snapshot.hardwareId),
        eq(hardwarePowerPolicies.version, snapshot.policyVersion),
        or(isNull(hardwarePowerPolicies.claim_token), lt(hardwarePowerPolicies.claim_expires_at, now)),
        sql`EXISTS (SELECT 1 FROM hardware_connections h WHERE h.id = ${snapshot.hardwareId}
          AND h.config_version = ${snapshot.configVersion} AND h.lifecycle_state = 'active'
          AND h.control_enabled = true)`))
      .returning({ hardware_id: hardwarePowerPolicies.hardware_id });
    return rows.length === 1;
  }

  async claimStillCurrent(snapshot: ControlSnapshot, token: string): Promise<boolean> {
    const [row] = await db.select({
      claim_token: hardwarePowerPolicies.claim_token,
      claim_expires_at: hardwarePowerPolicies.claim_expires_at,
      version: hardwarePowerPolicies.version,
      automation_enabled: hardwarePowerPolicies.automation_enabled,
      config_version: hardwareConnections.config_version,
      control_enabled: hardwareConnections.control_enabled,
      lifecycle_state: hardwareConnections.lifecycle_state,
    }).from(hardwarePowerPolicies)
      .innerJoin(hardwareConnections, eq(hardwareConnections.id, hardwarePowerPolicies.hardware_id))
      .where(eq(hardwarePowerPolicies.hardware_id, snapshot.hardwareId)).limit(1);
    return Boolean(row && row.claim_token === token && row.claim_expires_at
      && row.claim_expires_at.getTime() > Date.now()
      && row.version === snapshot.policyVersion && row.config_version === snapshot.configVersion
      && row.automation_enabled && row.control_enabled && row.lifecycle_state === 'active');
  }

  async finish(hardwareId: number, token: string, outcome: ClaimOutcome): Promise<void> {
    await db.transaction(async (tx) => {
      const set: Record<string, any> = {
        claim_token: null, claim_expires_at: null, last_outcome: outcome.outcome,
        latch: outcome.decision.latch,
        updated_at: new Date(),
      };
      if (outcome.outcome === 'verified' || outcome.outcome === 'already_set') set.last_verified_mode = outcome.target;
      const [released] = await tx.update(hardwarePowerPolicies).set(set)
        .where(and(eq(hardwarePowerPolicies.hardware_id, hardwareId), eq(hardwarePowerPolicies.claim_token, token)))
        .returning({ hardware_id: hardwarePowerPolicies.hardware_id });
      if (!released) return;
      await tx.insert(hardwarePowerOperations).values({
        hardware_id: hardwareId, actor: 'automation', prior_mode: outcome.prior,
        target_mode: outcome.target, reason: outcome.decision.reason,
        outcome: outcome.outcome, policy_version: outcome.decision.latch.policyVersion,
        price_revision: outcome.decision.latch.priceRevision || null,
      });
    });
  }

  async observe(hardwareId: number, version: number, decision: PowerDecision, actual: HardwareMode): Promise<void> {
    const set: Record<string, any> = { latch: decision.latch, updated_at: new Date() };
    if (decision.target === actual) set.last_verified_mode = actual;
    await db.update(hardwarePowerPolicies).set(set)
      .where(and(eq(hardwarePowerPolicies.hardware_id, hardwareId), eq(hardwarePowerPolicies.version, version), isNull(hardwarePowerPolicies.claim_token)));
  }

  async automatedHardwareIds(): Promise<number[]> {
    const rows = await db.select({ id: hardwareConnections.id }).from(hardwareConnections)
      .innerJoin(hardwarePowerPolicies, eq(hardwareConnections.id, hardwarePowerPolicies.hardware_id))
      .where(and(eq(hardwareConnections.lifecycle_state, 'active'), eq(hardwareConnections.control_enabled, true), eq(hardwarePowerPolicies.automation_enabled, true)));
    return rows.map((row) => row.id);
  }
}
