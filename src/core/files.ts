import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  parseMarkdownDocument,
  parseYaml,
  serializeMarkdownDocument,
  serializeYaml,
} from "./frontmatter";

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readText(filePath: string): Promise<string> {
  return await fs.readFile(filePath, "utf8");
}

export async function writeText(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
}

export async function appendText(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, text, "utf8");
}

export async function readYamlFile<T>(filePath: string): Promise<T> {
  return parseYaml<T>(await readText(filePath));
}

export async function writeYamlFile(filePath: string, data: unknown): Promise<void> {
  await writeText(filePath, serializeYaml(data));
}

export async function readMarkdownData<T extends object>(
  filePath: string,
): Promise<T> {
  const doc = parseMarkdownDocument<Record<string, unknown>>(await readText(filePath));
  return doc.data as unknown as T;
}

export async function writeMarkdownData<T extends Record<string, unknown>>(
  filePath: string,
  data: T,
  body: string,
): Promise<void> {
  await writeText(filePath, serializeMarkdownDocument(data, body));
}
