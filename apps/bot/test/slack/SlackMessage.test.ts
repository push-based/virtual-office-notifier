import { Duration } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { escapeSlackText, formatDuration } from "../../src/slack/SlackMessage.ts";

describe("escapeSlackText", () => {
  it("escapes Slack control characters", () => {
    expect(escapeSlackText("<!channel> & <@U123>")).toBe("&lt;!channel&gt; &amp; &lt;@U123&gt;");
  });

  it("does not double-escape an existing entity", () => {
    expect(escapeSlackText("&lt;")).toBe("&amp;lt;");
  });
});

describe("formatDuration", () => {
  it("rounds anything short down to under a minute", () => {
    expect(formatDuration(Duration.seconds(59))).toBe("under a minute");
  });

  it("shows minutes, hours, or both", () => {
    expect(formatDuration(Duration.minutes(14))).toBe("14m");
    expect(formatDuration(Duration.hours(2))).toBe("2h");
    expect(formatDuration(Duration.minutes(134))).toBe("2h 14m");
  });

  it("counts past a day in hours", () => {
    expect(formatDuration(Duration.hours(26))).toBe("26h");
  });
});
