import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ROLE_NAMES } from "@oh-my-roadmap/core/project-init";
import { parseYaml } from "@oh-my-roadmap/core/frontmatter";

// Guards against the README's illustrative `agents:` config sample drifting
// from the real role names oh-my-roadmap actually recognizes.

async function readReadme(): Promise<string> {
  return await fs.readFile(path.join(import.meta.dir, "..", "README.md"), "utf8");
}

function extractYamlBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const fenceRegex = /```yaml\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(markdown)) !== null) {
    blocks.push(match[1] ?? "");
  }
  return blocks;
}

describe("README config sample", () => {
  test("agents: sample role keys are a subset of the real ROLE_NAMES", async () => {
    const readme = await readReadme();
    const yamlBlocks = extractYamlBlocks(readme);
    expect(yamlBlocks.length).toBeGreaterThan(0);

    const agentsBlock = yamlBlocks.find((block) => {
      const parsed = parseYaml<Record<string, unknown>>(block);
      return parsed !== null && typeof parsed === "object" && "agents" in parsed;
    });

    expect(agentsBlock).toBeDefined();

    const parsed = parseYaml<{ agents: Record<string, unknown> }>(agentsBlock as string);
    const documentedRoles = Object.keys(parsed.agents);

    expect(documentedRoles.length).toBeGreaterThan(0);
    for (const role of documentedRoles) {
      expect(ROLE_NAMES as readonly string[]).toContain(role);
    }
  });
});
