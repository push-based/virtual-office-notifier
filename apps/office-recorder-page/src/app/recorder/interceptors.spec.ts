import { HttpClient, provideHttpClient, withInterceptors } from "@angular/common/http";
import { HttpTestingController, provideHttpClientTesting } from "@angular/common/http/testing";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { firstValueFrom } from "rxjs";
import { describe, expect, it } from "vite-plus/test";

import { apiErrorInterceptor, sessionInterceptor } from "./interceptors";
import { RecorderSession } from "./session";

const setup = (token: string | null) => {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([sessionInterceptor, apiErrorInterceptor])),
      provideHttpClientTesting(),
      { provide: RecorderSession, useValue: { token: signal(token) } },
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

    expect(backend.expectOne("/api/status").request.headers.get("authorization")).toBe("Bearer session-1");
  });
});

describe("apiErrorInterceptor", () => {
  it("names the endpoint and the status it answered with", async () => {
    const { http, backend } = setup(null);
    const response = firstValueFrom(http.get("/api/status"));

    backend.expectOne("/api/status").flush(null, { status: 502, statusText: "Bad Gateway" });

    await expect(response).rejects.toThrow("/api/status answered 502");
  });

  it("says when the endpoint didn't answer at all", async () => {
    const { http, backend } = setup(null);
    const response = firstValueFrom(http.get("/api/status"));

    backend.expectOne("/api/status").error(new ProgressEvent("error"));

    await expect(response).rejects.toThrow("/api/status didn't answer");
  });
});
