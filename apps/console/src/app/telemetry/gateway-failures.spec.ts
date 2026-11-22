import { pipe, String } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { BODY_LIMIT, describeGatewayFailure } from "./gateway-failures.ts";

describe("describeGatewayFailure", () => {
  it("keeps the status, the headers that say who answered, and the start of the body", () => {
    const details = describeGatewayFailure({
      status: 503,
      headers: {
        "retry-after": "5",
        "cf-ray": "8f00000000000000-FRA",
        server: "cloudflare",
        "content-type": "text/plain",
        authorization: "Bearer secret",
        "set-cookie": "session=secret",
      },
      body: `upstream connect error ${pipe("x", String.repeat(500))}`,
    });

    expect(details).toEqual({
      status: "503",
      "retry-after": "5",
      "cf-ray": "8f00000000000000-FRA",
      server: "cloudflare",
      "content-type": "text/plain",
      body: `upstream connect error ${pipe("x", String.repeat(BODY_LIMIT - 23))}`,
    });
  });

  it("leaves the body out when nothing came back", () => {
    expect(describeGatewayFailure({ status: 0, headers: {}, body: "" })).toEqual({ status: "0" });
  });
});
