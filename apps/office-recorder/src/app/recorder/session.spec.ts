import { provideHttpClient } from "@angular/common/http";
import { HttpTestingController, provideHttpClientTesting } from "@angular/common/http/testing";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it, vi } from "vite-plus/test";

import { DISCORD_CLIENT, type DiscordClient, RecorderSession } from "./session";

const fakeDiscord = () => ({
  ready: vi.fn<DiscordClient["ready"]>().mockResolvedValue(undefined),
  commands: {
    authorize: vi.fn<DiscordClient["commands"]["authorize"]>().mockResolvedValue({ code: "discord-code" }),
    authenticate: vi.fn<DiscordClient["commands"]["authenticate"]>(),
  },
});

describe("RecorderSession", () => {
  it("signs in through Discord and keeps the Worker's session", async () => {
    const discord = fakeDiscord();
    const createDiscordClient = vi.fn(() => discord);
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: DISCORD_CLIENT, useValue: createDiscordClient }],
    });
    const session = TestBed.inject(RecorderSession);
    const backend = TestBed.inject(HttpTestingController);

    const signingIn = session.signIn();
    backend.expectOne("/api/config").flush({ clientId: "client-1" });
    const tokenRequest = await vi.waitFor(() => backend.expectOne("/api/token"));
    tokenRequest.flush({ accessToken: "access-1", session: "session-1" });
    await signingIn;

    expect(createDiscordClient).toHaveBeenCalledWith("client-1");
    expect(tokenRequest.request.body).toEqual({ code: "discord-code" });
    expect(discord.commands.authenticate).toHaveBeenCalledWith({ access_token: "access-1" });
    expect(session.token()).toBe("session-1");
  });

  it("stays signed out when the Worker can't be reached", async () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const session = TestBed.inject(RecorderSession);
    const signingIn = session.signIn();

    TestBed.inject(HttpTestingController).expectOne("/api/config").flush(null, { status: 502, statusText: "Bad Gateway" });

    await expect(signingIn).rejects.toBeDefined();
    expect(session.token()).toBeNull();
  });
});
