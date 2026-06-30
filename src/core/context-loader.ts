import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseMarkdownDocument } from "./frontmatter";
import { fileExists, readText } from "./files";
import { loadActive } from "./store";
import { decisionsPath, milestoneNotesPath, roadmapDir, risksPath } from "./paths";
import type { ContextArtifact, ContextEntry } from "./context-types";

function titleFromBody(body: string): string {
  const heading = body.match(/^#{1,6}\s+(.+)$/m);
  return heading?.[1]?.trim() || "(untitled)";
}

function noteTitle(body: string): string {
  const heading = body.match(/^##\s+(.+)$/m);
  return heading?.[1]?.trim() || titleFromBody(body);
}

function parseNoteEntries(filePath: string, milestoneId: string, text: string, startOrder: number): ContextEntry[] {
  const entries: ContextEntry[] = [];
  const parts = text.split(/\n(?=---\nkind:)/g);
  let noteIndex = 0;
  for (const part of parts) {
    if (!part.startsWith("---\n")) continue;
    const doc = parseMarkdownDocument<Record<string, unknown>>(part);
    noteIndex += 1;
    entries.push({
      id: `notes:${milestoneId}:${noteIndex}`,
      artifact: "notes",
      path: filePath,
      milestoneId,
      title: noteTitle(doc.body),
      body: doc.body.trim(),
      metadata: doc.data,
      order: startOrder + entries.length,
    });
  }
  return entries;
}

function parseHeadingEntries(
  artifact: "decisions" | "risks",
  filePath: string,
  text: string,
  startOrder: number,
): ContextEntry[] {
  const matches = Array.from(text.matchAll(/^(#{1,6})\s+(.+)$/gm));
  const entries: ContextEntry[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!match || match.index === undefined) continue;
    const level = match[1]?.length ?? 1;
    if (index === 0 && level === 1) continue;

    const next = matches[index + 1];
    const end = next?.index ?? text.length;
    const title = match[2]?.trim() || "(untitled)";
    entries.push({
      id: `${artifact}:${entries.length + 1}`,
      artifact,
      path: filePath,
      title,
      body: text.slice(match.index, end).trim(),
      metadata: { heading_level: level },
      order: startOrder + entries.length,
    });
  }
  return entries;
}

async function loadNoteEntries(cwd: string, roadmapId: string, startOrder: number): Promise<ContextEntry[]> {
  const milestonesDir = path.join(roadmapDir(cwd, roadmapId), "milestones");
  let milestoneIds: string[];
  try {
    const dirents = await fs.readdir(milestonesDir, { withFileTypes: true });
    milestoneIds = dirents
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }

  const entries: ContextEntry[] = [];
  for (const milestoneId of milestoneIds) {
    const filePath = milestoneNotesPath(cwd, roadmapId, milestoneId);
    if (!(await fileExists(filePath))) continue;
    entries.push(...parseNoteEntries(filePath, milestoneId, await readText(filePath), startOrder + entries.length));
  }
  return entries;
}

export async function loadContextEntries(
  cwd: string,
  artifacts: ContextArtifact[],
): Promise<{ roadmapId?: string; entries: ContextEntry[] }> {
  const active = await loadActive(cwd);
  if (!active) return { entries: [] };

  const entries: ContextEntry[] = [];
  if (artifacts.includes("notes")) {
    entries.push(...(await loadNoteEntries(cwd, active.roadmap_id, entries.length)));
  }
  if (artifacts.includes("decisions")) {
    const filePath = decisionsPath(cwd, active.roadmap_id);
    if (await fileExists(filePath)) {
      entries.push(...parseHeadingEntries("decisions", filePath, await readText(filePath), entries.length));
    }
  }
  if (artifacts.includes("risks")) {
    const filePath = risksPath(cwd, active.roadmap_id);
    if (await fileExists(filePath)) {
      entries.push(...parseHeadingEntries("risks", filePath, await readText(filePath), entries.length));
    }
  }
  return { roadmapId: active.roadmap_id, entries };
}
