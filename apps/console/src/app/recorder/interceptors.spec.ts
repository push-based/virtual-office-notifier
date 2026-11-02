import { HttpClient, provideHttpClient, withInterceptors } from "@angular/common/http";
import { HttpTestingController, provideHttpClientTesting } from "@angular/common/http/testing";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { firstValueFrom } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  apiErrorInterceptor,
  RETRY_TIMING,
  retryInterceptor,
  sessionInterceptor,
} from "./interceptors";
import { GATEWAY_FAILURES, type GatewayFailures } from "../telemetry/gateway-failures";
import { RecorderSession } from "./session";

const fakeFailures = () => {
  const noted: Array<string> = [];

  const failures: GatewayFailures = {
    retrying: (url, error) => noted.push(`retrying ${url} ${error.status}`),
    gaveUp: (url, error) => noted.push(`gave up ${url} ${error.status}`),
  };

  return { noted, failures };
};

const setup = (token: string | null, failures = fakeFailures().failures) => {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(
        withInterceptors([sessionInterceptor, apiErrorInterceptor, retryInterceptor]),
      ),
      provideHttpClientTesting(),
      { provide: RecorderSession, useValue: { token: signal(token) } },
      { provide: RETRY_TIMING, useValue: { retries: 2, retryMs: 1000 } },
      { provide: GATEWAY_FAILURES, useValue: failures },
    ],
  });

  return { http: TestBed.inject(HttpClient), backend: TestBed.inject(HttpTestingController) };
};

describe("sessionInterceptor", () => {
  it("sends no credentials before sign-in", () => {
    const { http, backend } = setup(null);

    void firstValueFrom(http.get("/api/config"));

    expect(backend.expectOne("/api/config").request.headers.has("authorization")).toBe(false);
  });

  it("sends the session as a bearer token after sign-in", () => {
    const { http, backend } = setup("session-1");

    void firstValueFrom(http.get("/api/status"));

    expect(backend.expectOne("/api/status").request.headers.get("authorization")).toBe(
      "Bearer session-1",
    );
  });
});

describe("apiErrorInterceptor", () => {
  it("names the endpoint and the status it answered with", async () => {
    const { http, backend } = setup(null);
    const response = firstValueFrom(http.get("/api/status"));

    backend.expectOne("/api/status").flush(null, { status: 500, statusText: "Server Error" });

    await expect(response).rejects.toThrow("/api/status answered 500");
  });

  it("says when the endpoint didn't answer at all", async () => {
    vi.useFakeTimers();

    const { http, backend } = setup(null);
    const response = firstValueFrom(http.get("/api/status"));

    backend.expectOne("/api/status").error(new ProgressEvent("error"));
    await vi.advanceTimersByTimeAsync(1000);
    backend.expectOne("/api/status").error(new ProgressEvent("error"));
    await vi.advanceTimersByTimeAsync(1000);
    backend.expectOne("/api/status").error(new ProgressEvent("error"));

    await expect(response).rejects.toThrow("/api/status didn't answer");

    vi.useRealTimers();
  });
});

const unavailable = { status: 503, statusText: "Service Unavailable" };

describe("retryInterceptor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks again when Discord's proxy briefly answers 503", async () => {
    const { http, backend } = setup(null);
    const response = firstValueFrom(http.get("/api/status"));

    backend.expectOne("/api/status").flush(null, unavailable);
    await vi.advanceTimersByTimeAsync(999);
    backend.expectNone("/api/status");
    await vi.advanceTimersByTimeAsync(1);
    backend.expectOne("/api/status").flush({ botInOffice: true });

    await expect(response).resolves.toEqual({ botInOffice: true });
  });

  it("gives up with the last failure once the retries are used up", async () => {
    const { http, backend } = setup(null);
    const response = firstValueFrom(http.get("/api/status"));

    backend.expectOne("/api/status").flush(null, unavailable);
    await vi.advanceTimersByTimeAsync(1000);
    backend.expectOne("/api/status").flush(null, unavailable);
    await vi.advanceTimersByTimeAsync(1000);
    backend.expectOne("/api/status").flush(null, unavailable);

    await expect(response).rejects.toThrow("/api/status answered 503");
    backend.verify();
  });

  it("doesn't ask again when the Worker itself refused", async () => {
    const { http, backend } = setup(null);
    const response = firstValueFrom(http.get("/api/status"));

    backend.expectOne("/api/status").flush(null, { status: 401, statusText: "Unauthorized" });

    await expect(response).rejects.toThrow("/api/status answered 401");
    await vi.advanceTimersByTimeAsync(5000);
    backend.verify();
  });

  it("never sends a request that changes something twice", async () => {
    const { http, backend } = setup(null);
    const response = firstValueFrom(http.post("/api/requests", { action: "start" }));

    backend.expectOne("/api/requests").flush(null, unavailable);

    await expect(response).rejects.toThrow("/api/requests answered 503");
    await vi.advanceTimersByTimeAsync(5000);
    backend.verify();
  });

  it("notes each retry and reports giving up, so the proxy's answer reaches Sentry", async () => {
    const { noted, failures } = fakeFailures();
    const { http, backend } = setup(null, failures);
    const response = firstValueFrom(http.get("/api/status"));

    backend.expectOne("/api/status").flush(null, unavailable);
    await vi.advanceTimersByTimeAsync(1000);
    backend.expectOne("/api/status").flush(null, unavailable);
    await vi.advanceTimersByTimeAsync(1000);
    backend.expectOne("/api/status").flush(null, unavailable);

    await expect(response).rejects.toThrow("/api/status answered 503");
    expect(noted).toEqual([
      "retrying /api/status 503",
      "retrying /api/status 503",
      "gave up /api/status 503",
    ]);
  });

  it("reports nothing when a retry gets through", async () => {
    const { noted, failures } = fakeFailures();
    const { http, backend } = setup(null, failures);
    const response = firstValueFrom(http.get("/api/status"));

    backend.expectOne("/api/status").flush(null, unavailable);
    await vi.advanceTimersByTimeAsync(1000);
    backend.expectOne("/api/status").flush({ botInOffice: true });

    await response;
    expect(noted).toEqual(["retrying /api/status 503"]);
  });

  it("reports a request that changes something failing at the proxy, and the Worker's own errors not at all", async () => {
    const { noted, failures } = fakeFailures();
    const { http, backend } = setup(null, failures);
    const started = firstValueFrom(http.post("/api/requests", { action: "start" }));
    const status = firstValueFrom(http.get("/api/status"));

    backend.expectOne("/api/requests").flush(null, unavailable);
    backend.expectOne("/api/status").flush(null, { status: 500, statusText: "Server Error" });

    await expect(started).rejects.toThrow();
    await expect(status).rejects.toThrow();
    expect(noted).toEqual(["gave up /api/requests 503"]);
  });
});
