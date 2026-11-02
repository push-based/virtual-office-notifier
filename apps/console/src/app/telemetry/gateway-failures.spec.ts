import { HttpErrorResponse, HttpHeaders } from "@angular/common/http";
import { describe, expect, it } from "vite-plus/test";

import { BODY_LIMIT, describeGatewayFailure } from "./gateway-failures";

describe("describeGatewayFailure", () => {
  it("keeps the status, the headers that say who answered, and the start of the body", () => {
    const error = new HttpErrorResponse({
      status: 503,
      statusText: "Service Unavailable",
      headers: new HttpHeaders({
        "retry-after": "5",
        "cf-ray": "8f00000000000000-FRA",
        server: "cloudflare",
        "content-type": "text/plain",
        authorization: "Bearer secret",
        "set-cookie": "session=secret",
      }),
      error: `upstream connect error ${"x".repeat(500)}`,
    });

    const details = describeGatewayFailure(error);

    expect(details).toEqual({
      status: "503",
      statusText: "Service Unavailable",
      "retry-after": "5",
      "cf-ray": "8f00000000000000-FRA",
      server: "cloudflare",
      "content-type": "text/plain",
      body: `upstream connect error ${"x".repeat(BODY_LIMIT - 23)}`,
    });
  });

  it("leaves the body out when nothing came back", () => {
    const error = new HttpErrorResponse({ status: 0, error: new ProgressEvent("error") });

    expect(describeGatewayFailure(error)).toEqual({ status: "0", statusText: "Unknown Error" });
  });

  it("writes a JSON body out as JSON", () => {
    const error = new HttpErrorResponse({
      status: 502,
      statusText: "Bad Gateway",
      error: { message: "no upstream" },
    });

    expect(describeGatewayFailure(error)["body"]).toBe('{"message":"no upstream"}');
  });
});
