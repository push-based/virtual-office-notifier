import { describe, expect, it } from "vitest";

import { InitialsPipe } from "./initials.pipe";

describe("InitialsPipe", () => {
  const pipe = new InitialsPipe();

  it("takes the first letter of the first two names", () => {
    expect(pipe.transform("ada king lovelace")).toBe("AK");
  });

  it("handles a single name", () => {
    expect(pipe.transform("Linus")).toBe("L");
  });
});
