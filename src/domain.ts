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
