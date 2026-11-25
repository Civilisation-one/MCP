export const EVIDENCE_STATUSES = [
  "ESTABLISHED", "SUPPORTED", "HYPOTHESIS", "SPECULATION", "UNKNOWN", "REFUTED",
] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];
export const GATE_STATUSES = ["PASS", "FAIL", "BLOCKED", "INCONCLUSIVE"] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

export interface EvidenceRecord {
  id: string; reference: string; description: string; status: EvidenceStatus;
  sourceUri?: string; recordedAt: string;
}
export interface ObjectionRecord {
  id: string; statement: string; raisedBy: string; resolved: boolean; recordedAt: string;
}
export interface GateRecord { gate: string; status: GateStatus; rationale: string; recordedAt: string; }
export interface AuditEvent { sequence: number; type: string; at: string; details: Record<string, unknown>; }
/** A claim as an outside source states it. Nothing here is trusted: the source's own status is recorded
 *  as "assertedStatus", never applied. */
export interface ExternalClaimInput {
  statement: string; reference: string; sourceUri?: string; assertedStatus?: string;
  /** The observation or check that would settle the claim. Without one the claim is SPECULATION. */
  test?: string;
}
export interface ExternalImportInput {
  source: string; snapshot: string; sourceUri?: string; claims: ExternalClaimInput[];
}
export interface ExternalImportResult {
  missionId: string; source: string; snapshot: string;
  imported: Array<{ evidenceId: string; status: EvidenceStatus; assertedStatus?: string; downgraded: boolean }>;
  objections: string[];
}

export interface PublicDataEvidenceInput {
  source: string; sourceLabel: string; dataset: string; title?: string; url: string; retrievedAt: string;
  sha256: string; bytes: number; observationCount: number; areaCount: number; periods: string[]; truncated: boolean;
}

export interface ScienceDataEvidenceInput {
  source: string; sourceLabel: string; dataset: string; kind: "records" | "table" | "measurements" | "raw";
  count: number; truncated: boolean; url: string; retrievedAt: string; sha256: string; bytes: number; dois: string[];
}

/** External material can be at most HYPOTHESIS here (and only with a named test). Raising it to SUPPORTED
 *  or ESTABLISHED needs evidence checked inside Civilisation.One, recorded separately. */
export const EXTERNAL_MAX_STATUS: EvidenceStatus = "HYPOTHESIS";

/** Words that assert authority, verification or entitlement. Text cannot grant any of these, so each match
 *  is recorded as an objection for review; the claim is imported unchanged. */
export const AUTHORITY_PATTERNS: Array<[RegExp, string]> = [
  [/\[\s*root\s*\]|\broot\s+(access|authori[sz])/i, "claims root authority"],
  [/\[\s*human_cso\s*\]/i, "claims an officer's authorisation"],
  [/\bauthori[sz](ed|ation|e)\b/i, "claims authorisation"],
  [/\b(royalt(y|ies)|revenue[\s-]*(split|share)|\d{1,3}\s*\/\s*\d{1,3}\s*(split|share))\b/i, "claims a revenue or royalty entitlement"],
  [/\b(verified|proven|proved|dokazano|verifikacija uspje\u0161na)\b/i, "claims to be verified or proven"],
  [/\b(priority claim|irrevocable)\b/i, "claims priority or irrevocability"],
];

export function authorityFlags(text: string): string[] {
  return AUTHORITY_PATTERNS.filter(([re]) => re.test(text)).map(([, why]) => why);
}

export function externalStatus(claim: ExternalClaimInput): EvidenceStatus {
  return claim.test && claim.test.trim() ? EXTERNAL_MAX_STATUS : "SPECULATION";
}

export interface Mission {
  id: string; goal: string; constraints: string[]; status: "OPEN" | "CLOSED"; createdAt: string;
  evidence: EvidenceRecord[]; objections: ObjectionRecord[]; gates: GateRecord[]; audit: AuditEvent[];
}

export class Civ1Domain {
  private readonly missions = new Map<string, Mission>();
  private nextId = 1;

  createMission(goal: string, constraints: string[] = []): Mission {
    const id = `CIV1-M-${String(this.nextId++).padStart(5, "0")}`;
    const mission: Mission = {
      id, goal, constraints: [...constraints], status: "OPEN", createdAt: new Date().toISOString(),
      evidence: [], objections: [], gates: [], audit: [],
    };
    this.missions.set(id, mission);
    this.appendAudit(mission, "MISSION_CREATED", { goal, constraints });
    return this.clone(mission);
  }

  listMissions(): Array<Pick<Mission, "id" | "goal" | "status" | "createdAt">> {
    return [...this.missions.values()].map(({ id, goal, status, createdAt }) => ({ id, goal, status, createdAt }));
  }

  getMission(id: string): Mission | undefined {
    const mission = this.missions.get(id);
    return mission ? this.clone(mission) : undefined;
  }

  recordEvidence(missionId: string, input: Omit<EvidenceRecord, "id" | "recordedAt">): EvidenceRecord {
    const mission = this.requireOpenMission(missionId);
    const record: EvidenceRecord = { ...input, id: `E-${mission.evidence.length + 1}`, recordedAt: new Date().toISOString() };
    mission.evidence.push(record);
    this.appendAudit(mission, "EVIDENCE_RECORDED", { id: record.id, status: record.status, reference: record.reference });
    return { ...record };
  }

  recordObjection(missionId: string, statement: string, raisedBy: string): ObjectionRecord {
    const mission = this.requireOpenMission(missionId);
    const record: ObjectionRecord = {
      id: `O-${mission.objections.length + 1}`, statement, raisedBy, resolved: false, recordedAt: new Date().toISOString(),
    };
    mission.objections.push(record);
    this.appendAudit(mission, "OBJECTION_RECORDED", { id: record.id, raisedBy });
    return { ...record };
  }

  setGateStatus(missionId: string, gate: string, status: GateStatus, rationale: string): GateRecord {
    const mission = this.requireOpenMission(missionId);
    const record: GateRecord = { gate, status, rationale, recordedAt: new Date().toISOString() };
    mission.gates.push(record);
    this.appendAudit(mission, "GATE_STATUS_RECORDED", { gate, status, rationale });
    return { ...record };
  }

  /** One-way import of an outside source's claims into an open mission. Statuses are capped (see
   *  externalStatus); authority, verification and entitlement language becomes objections. Nothing is
   *  fetched, and nothing is sent back to the source. */
  importExternalSource(missionId: string, input: ExternalImportInput): ExternalImportResult {
    const mission = this.requireOpenMission(missionId);
    if (!input.claims.length) throw new Error("An import needs at least one claim");
    const imported: ExternalImportResult["imported"] = [];
    const objections: string[] = [];
    for (const claim of input.claims) {
      const status = externalStatus(claim);
      const asserted = claim.assertedStatus?.trim() || undefined;
      const description = [
        `External claim from ${input.source} (snapshot ${input.snapshot}), not verified by Civilisation.One: ${claim.statement}`,
        asserted ? `Source asserts status: ${asserted}.` : "",
        claim.test ? `Test that would settle it: ${claim.test}` : "No test named.",
      ].filter(Boolean).join(" ");
      const ev = this.recordEvidence(missionId, {
        reference: `${input.source}@${input.snapshot}:${claim.reference}`, description, status,
        sourceUri: claim.sourceUri ?? input.sourceUri,
      });
      const downgraded = asserted !== undefined && asserted.toUpperCase() !== status;
      imported.push({ evidenceId: ev.id, status, assertedStatus: asserted, downgraded });
      for (const why of authorityFlags(`${claim.statement} ${asserted ?? ""}`)) {
        const o = this.recordObjection(missionId,
          `${ev.id} ${why}. Text from an outside source cannot grant authority, verification or entitlement; ` +
          "it needs separate evidence (for example a signed agreement or a check that ran here).",
          "civ1-external-import");
        objections.push(o.id);
      }
    }
    this.appendAudit(mission, "EXTERNAL_SOURCE_IMPORTED", {
      source: input.source, snapshot: input.snapshot, claims: input.claims.length,
      downgraded: imported.filter((i) => i.downgraded).length, objections: objections.length,
    });
    return { missionId, source: input.source, snapshot: input.snapshot, imported, objections };
  }

  /** Records one public-data fetch as a single evidence item. The data are source-reported: Civilisation.One
   *  did not observe them, so the status is capped like any outside source (HYPOTHESIS, with the test named).
   *  The retrieval itself is pinned by URL, time and SHA-256 of the response body, so anyone can re-fetch and
   *  compare; that proves what the source said, not that it is true. */
  recordPublicData(missionId: string, input: PublicDataEvidenceInput): EvidenceRecord {
    const mission = this.requireOpenMission(missionId);
    const periods = input.periods.length ? `${input.periods[0]}–${input.periods[input.periods.length - 1]}` : "no periods";
    const description = [
      `Public data from ${input.sourceLabel}${input.title ? ` — ${input.title}` : ""} (${input.dataset}):`,
      `${input.observationCount} observations, ${input.areaCount} areas, ${periods}${input.truncated ? ", truncated by the source's paging or the local cap" : ""}.`,
      `Source-reported, not observed or verified by Civilisation.One; the series may mix measured values, estimates and projections (see each observation's flag).`,
      `Retrieved ${input.retrievedAt}, ${input.bytes} bytes, sha256 ${input.sha256}.`,
      `Test that would settle it: re-fetch the URL and compare the hash, then check against an independent source.`,
    ].join(" ");
    const record = this.recordEvidence(missionId, {
      reference: `public-data:${input.source}:${input.dataset}@${input.retrievedAt}#sha256=${input.sha256}`,
      description, status: EXTERNAL_MAX_STATUS, sourceUri: input.url,
    });
    this.appendAudit(mission, "PUBLIC_DATA_RECORDED", {
      evidenceId: record.id, source: input.source, dataset: input.dataset, url: input.url, sha256: input.sha256,
      observations: input.observationCount, truncated: input.truncated,
    });
    return record;
  }

  /** Records one scientific-archive fetch (catalogue records, a TAP table or a HEPData table) as a single
   *  evidence item, capped like any outside source and pinned by URL, time and SHA-256. */
  recordScienceData(missionId: string, input: ScienceDataEvidenceInput): EvidenceRecord {
    const mission = this.requireOpenMission(missionId);
    const what = { records: "catalogue records", table: "table rows", measurements: "data points", raw: "unparsed response" }[input.kind];
    const description = [
      `Scientific archive data from ${input.sourceLabel} (${input.dataset}):`,
      input.kind === "raw" ? "an unparsed response." : `${input.count} ${what}${input.truncated ? ", truncated" : ""}.`,
      input.dois.length ? `DOIs: ${input.dois.join(", ")}.` : "",
      "Published by the archive or collaboration; not observed or verified by Civilisation.One.",
      `Retrieved ${input.retrievedAt}, ${input.bytes} bytes, sha256 ${input.sha256}.`,
      "Test that would settle it: re-run the query and compare the hash, then check against an independent measurement.",
    ].filter(Boolean).join(" ");
    const record = this.recordEvidence(missionId, {
      reference: `science-data:${input.source}:${input.dataset}@${input.retrievedAt}#sha256=${input.sha256}`.slice(0, 500),
      description, status: EXTERNAL_MAX_STATUS, sourceUri: input.url.slice(0, 2000),
    });
    this.appendAudit(mission, "SCIENCE_DATA_RECORDED", {
      evidenceId: record.id, source: input.source, dataset: input.dataset, url: input.url, sha256: input.sha256,
      kind: input.kind, count: input.count, truncated: input.truncated,
    });
    return record;
  }

  closeMission(missionId: string): Mission {
    const mission = this.requireMission(missionId);
    if (mission.status !== "CLOSED") {
      mission.status = "CLOSED";
      this.appendAudit(mission, "MISSION_CLOSED", {});
    }
    return this.clone(mission);
  }

  private requireMission(id: string): Mission {
    const mission = this.missions.get(id);
    if (!mission) throw new Error(`Mission not found: ${id}`);
    return mission;
  }
  private requireOpenMission(id: string): Mission {
    const mission = this.requireMission(id);
    if (mission.status !== "OPEN") throw new Error(`Mission is closed: ${id}`);
    return mission;
  }
  private appendAudit(mission: Mission, type: string, details: Record<string, unknown>): void {
    mission.audit.push({ sequence: mission.audit.length + 1, type, at: new Date().toISOString(), details: structuredClone(details) });
  }
  private clone(mission: Mission): Mission { return structuredClone(mission); }
}
