import { Runtime } from "foldkit";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { fakeDiscord, fakeResources, fakeServer, type SentRequest } from "./fakes.ts";
import { init, Model, subscriptions, update, view } from "./main.ts";
import type { RecordingStatus } from "./wire.ts";

const idle: RecordingStatus = {
  botInOffice: true,
  occupants: [{ userId: "u1", displayName: "Ada", avatarUrl: null, speaking: true }],
  recording: null,
  updatedAt: "2026-10-27T12:00:00Z",
};

const recording: RecordingStatus = {
  ...idle,
  recording: {
    id: "r1",
    startedAt: "2026-10-27T12:00:00Z",
    startedByName: "Ada",
    endsAt: "2026-10-27T16:00:00Z",
    pause: null,
    title: "Deploy retro",
    agenda: null,
    summaryStyle: "brief",
  },
};

const office = () => {
  let status = idle;

  const routes = (request: SentRequest) => {
    if (request.path === "/api/telemetry") return { body: null };

    if (request.path === "/api/config") return { body: { clientId: "client-1" } };

    if (request.path === "/api/token")
      return {
        body: {
          accessToken: "access-1",
          session: "session-1",
          user: { id: "u1", name: "Ada", avatarUrl: null },
        },
      };

    if (request.path === "/api/status") return { body: status };

    if (request.path === "/api/recordings") return { body: { recordings: [], older: null } };

    if (request.path === "/api/requests") {
      status = recording;

      return { status: 202, body: { id: 7, outcome: null } };
    }

    if (request.path === "/api/requests/7") return { body: { id: 7, outcome: "started" } };

    return { status: 404 };
  };

  return fakeServer(routes);
};

const started = () => {
  const server = office();
  const discord = fakeDiscord();
  const container = document.createElement("div");
  const wrapper = document.createElement("div");

  container.id = "console";

  wrapper.append(container);
  document.body.append(wrapper);

  const handle = Runtime.embed(
    Runtime.makeElement({
      Model,
      init,
      update,
      view: (model, h) => view(model, h).body,
      subscriptions,
      resources: fakeResources(server, discord),
      container,
    }),
  );

  return { server, discord, wrapper, handle };
};

const text = (element: HTMLElement) => element.textContent ?? "";

describe("the Console", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("signs in through Discord, then shows the office and who's in it", async () => {
    const { server, discord, wrapper, handle } = started();

    await vi.waitFor(() => expect(text(wrapper)).toContain("Not recording"));

    expect(text(wrapper)).toContain("In the office · 1");
    expect(discord.commands.authenticate).toHaveBeenCalledWith({ access_token: "access-1" });
    expect(server.sent.find(({ path }) => path === "/api/config")?.authorization).toBeUndefined();
    expect(server.sent.find(({ path }) => path === "/api/status")?.authorization).toBe(
      "Bearer session-1",
    );
    await vi.waitFor(() =>
      expect(discord.commands.setActivity).toHaveBeenCalledWith({
        activity: { details: "In the office", state: "Not recording", timestamps: null },
      }),
    );

    await handle.disposeAsync();
  });

  it("starts a recording with the plan and says once the bot started it", async () => {
    const { server, wrapper, handle } = started();

    await vi.waitFor(() => expect(text(wrapper)).toContain("Not recording"));

    const title = wrapper.querySelector<HTMLInputElement>("#plan-title");

    if (title === null) throw new Error("The plan has no title field");

    title.value = "Deploy retro";
    title.dispatchEvent(new Event("input", { bubbles: true }));

    const start = [...wrapper.querySelectorAll("button")].find(
      (button) => text(button) === "Start recording",
    );

    start?.click();

    await vi.waitFor(() => expect(text(wrapper)).toContain("Recording started."), {
      timeout: 5000,
    });

    expect(server.sent.find(({ path }) => path === "/api/requests")?.body).toEqual({
      action: "start",
      title: "Deploy retro",
      agenda: null,
      summaryStyle: "brief",
    });
    await vi.waitFor(() => expect(text(wrapper)).toContain("Stop recording"));

    await handle.disposeAsync();
  });
});
