import { describe, expect, test } from "bun:test";
import { styleValue } from "../packages/extension/src/extension/report-ui/text";

const GREEN = "[32m";
const RED = "[31m";
const CYAN = "[36m";
const YELLOW = "[33m";

describe("styleValue semantic coloring", () => {
  test("terminal, in-flight, and pending states get distinct colors", () => {
    expect(styleValue("passed")).toContain(GREEN);
    expect(styleValue("approved")).toContain(GREEN);
    expect(styleValue("complete")).toContain(GREEN);
    expect(styleValue("failed")).toContain(RED);
    expect(styleValue("blocked")).toContain(RED);
    expect(styleValue("running")).toContain(CYAN);
    expect(styleValue("reviewing")).toContain(CYAN);
    expect(styleValue("implementing")).toContain(CYAN);
    expect(styleValue("deferred")).toContain(YELLOW);
    expect(styleValue("adhoc_draft")).toContain(YELLOW);
    expect(styleValue("pending")).toContain("[2m"); // dim
  });

  test("colors keywords embedded in free text", () => {
    expect(styleValue("wave w1 is running now")).toContain(CYAN);
    expect(styleValue("check approved by user")).toContain(GREEN);
  });
});
