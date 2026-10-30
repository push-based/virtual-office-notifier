import { provideHttpClient } from "@angular/common/http";
import { HttpTestingController, provideHttpClientTesting } from "@angular/common/http/testing";
import { ErrorHandler } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import * as Sentry from "@sentry/angular";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { provideTelemetry, sentryOptionsFor, type Telemetry } from "./telemetry";

const telemetry: Telemetry = {
  dsn: "https://public@o1.ingest.sentry.io/42",
  environment: "production",
  release: "abc123",
};

const setup = () => {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), provideTelemetry()],
  });

  return TestBed.inject(HttpTestingController);
};

afterEach(async () => {
  await Sentry.close();
  vi.restoreAllMocks();
});

describe("provideTelemetry", () => {
  it("sends nothing when the Worker has no DSN", () => {
    setup().expectOne("/api/telemetry").flush(null);

    expect(Sentry.getClient()).toBeUndefined();
  });

  it("sends nothing when the Worker can't say where to", () => {
    setup()
      .expectOne("/api/telemetry")
      .flush(null, { status: 503, statusText: "Service Unavailable" });

    expect(Sentry.getClient()).toBeUndefined();
  });

  it("starts Sentry with what the Worker serves, without console breadcrumbs", () => {
    setup().expectOne("/api/telemetry").flush(telemetry);

    expect(Sentry.getClient()?.getOptions()).toMatchObject({
      dsn: telemetry.dsn,
      environment: "production",
      release: "abc123",
      tunnel: "/api/sentry",
      dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [] },
    });
    expect(Sentry.getClient()?.getIntegrationByName("BrowserTracing")).toBeDefined();
    expect(Sentry.getClient()?.getIntegrationByName("Console")).toBeUndefined();
  });

  it("reports the errors Angular handles through the Worker", async () => {
    const sentTo: Array<string> = [];
    const errors: Array<string | undefined> = [];

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setup();

    Sentry.init({
      ...sentryOptionsFor(telemetry),
      transport: (options) =>
        Sentry.createTransport(options, () => {
          sentTo.push(options.url);

          return Promise.resolve({});
        }),
      beforeSend: (event) => {
        errors.push(event.exception?.values?.[0]?.value);

        return event;
      },
    });

    TestBed.inject(ErrorHandler).handleError(new Error("The page caught fire"));
    await Sentry.flush(2000);

    expect(errors).toEqual(["The page caught fire"]);
    expect(new Set(sentTo)).toEqual(new Set(["/api/sentry"]));
  });
});
