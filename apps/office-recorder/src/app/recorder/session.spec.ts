import { provideHttpClient } from "@angular/common/http";
import { HttpTestingController, provideHttpClientTesting } from "@angular/common/http/testing";
import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { Presence } from "./describe-presence";
import { DISCORD_CLIENT, type DiscordClient, RecorderSession } from "./session";

const fakeDiscord = () => ({
  ready: vi.fn<DiscordClient["ready"]>().mockResolvedValue(undefined),
  commands: {
    authorize: vi
      .fn<DiscordClient["commands"]["authorize"]>()
      .mockResolvedValue({ code: "discord-code" }),
    authenticate: vi.fn<DiscordClient["commands"]["authenticate"]>(),
    setActivity: vi.fn<DiscordClient["commands"]["setActivity"]>(),
    openExternalLink: vi
      .fn<DiscordClient["commands"]["openExternalLink"]>()
      .mockResolvedValue({ opened: true }),
  },
});

type FakeDiscord = ReturnType<typeof fakeDiscord>;

const recordingPresence: Presence = {
  details: "Recording the office",
  state: "Started by Anna",
  timestamps: { start: Date.parse("2026-10-27T12:00:00Z") },
};

const signedIn = async (discord: FakeDiscord) => {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: DISCORD_CLIENT, useValue: () => discord },
    ],
  });
  const session = TestBed.inject(RecorderSession);
  const backend = TestBed.inject(HttpTestingController);

  const signingIn = session.signIn();
  backend.expectOne("/api/config").flush({ clientId: "client-1" });
  const tokenRequest = await vi.waitFor(() => backend.expectOne("/api/token"));
  tokenRequest.flush({ accessToken: "access-1", session: "session-1" });
  await signingIn;

  return session;
};

describe("RecorderSession", () => {
  afterEach(() => vi.restoreAllMocks());

  it("signs in through Discord and keeps the Worker's session", async () => {
    const discord = fakeDiscord();
    const createDiscordClient = vi.fn(() => discord);
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: DISCORD_CLIENT, useValue: createDiscordClient },
      ],
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

  it("asks to set the Rich Presence along with the identity", async () => {
    const discord = fakeDiscord();
    await signedIn(discord);

    expect(discord.commands.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ scope: ["identify", "rpc.activities.write"] }),
    );
  });

  it("shows the presence on the viewer's Discord profile", async () => {
    const discord = fakeDiscord();
    const session = await signedIn(discord);

    await session.showPresence(recordingPresence);

    expect(discord.commands.setActivity).toHaveBeenCalledWith({ activity: recordingPresence });
  });

  it("only logs a presence Discord refused", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const discord = fakeDiscord();
    const refusal = new Error("Missing scope");
    discord.commands.setActivity.mockRejectedValue(refusal);
    const session = await signedIn(discord);

    await expect(session.showPresence(recordingPresence)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith("Couldn't update the Rich Presence", refusal);
  });

  it("opens links outside the Activity through Discord", async () => {
    const discord = fakeDiscord();
    const session = await signedIn(discord);

    await session.openExternalLink("https://office.slack.com/archives/C1/p12");

    expect(discord.commands.openExternalLink).toHaveBeenCalledWith({
      url: "https://office.slack.com/archives/C1/p12",
    });
  });

  it("shows no presence before signing in", async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });

    await expect(
      TestBed.inject(RecorderSession).showPresence(recordingPresence),
    ).resolves.toBeUndefined();
  });

  it("stays signed out when the Worker can't be reached", async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const session = TestBed.inject(RecorderSession);
    const signingIn = session.signIn();

    TestBed.inject(HttpTestingController)
      .expectOne("/api/config")
      .flush(null, { status: 502, statusText: "Bad Gateway" });

    await expect(signingIn).rejects.toBeDefined();
    expect(session.token()).toBeNull();
  });
});
