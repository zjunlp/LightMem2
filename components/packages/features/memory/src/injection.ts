import type { SkillRetrieveHit } from "./types.js";

export function formatProceduralMemoryInjection(hits: SkillRetrieveHit[]): string {
  if (hits.length === 0) return "";
  const lines: string[] = [];
  lines.push("[TokenPilot Procedural Memory]");
  lines.push("Retain only concrete points that directly help the current objective.");
  for (const hit of hits) {
    lines.push("");
    lines.push(`Skill: ${hit.skill.title}`);
    if (hit.skill.facts.length > 0) lines.push(`Facts: ${hit.skill.facts.join(" | ")}`);
    if (hit.skill.whenToUse.length > 0) lines.push(`Objective: ${hit.skill.whenToUse.join(" | ")}`);
    if (hit.skill.pitfalls.length > 0) lines.push(`Pitfalls: ${hit.skill.pitfalls.join(" | ")}`);
    if (hit.skill.constraints.length > 0) lines.push(`Constraints: ${hit.skill.constraints.join(" | ")}`);
  }
  return lines.join("\n").trim();
}
