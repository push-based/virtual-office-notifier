import { Array, DateTime, Duration, Effect, Match, Option, Ref } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import type { ConsentStatus, ErasureCase } from "office-domain/Consent";
import type { OfficeStats } from "office-domain/OfficeStats";
import type { ListedRecording, OfficeMember, RecordingDetail } from "office-domain/Recording";
import { RecordingApi, RecordingNotFound } from "office-domain/RecordingApi";
import type {
  HandledRequest,
  Occupant,
  RecordingStatus,
  RequestSubmission,
  RunningRecording,
} from "office-domain/RecordingRequest";

import type { DiscordClient } from "../session/session.ts";
import { fakeResources, fakeWorker } from "./fake-worker.ts";

export const SCENARIOS = ["idle", "recording", "paused", "away", "admin"] as const;

export type Scenario = (typeof SCENARIOS)[number];

export const scenarioOf = (search: string): Scenario =>
  Option.getOrElse(
    Array.findFirst(
      SCENARIOS,
      (scenario) => scenario === new URLSearchParams(search).get("scenario"),
    ),
    (): Scenario => "idle",
  );

const at = (iso: string) => DateTime.makeUnsafe(iso);

const anna: OfficeMember = { userId: "u1", name: "Anna", avatarUrl: null };

const ben: OfficeMember = { userId: "u2", name: "Ben", avatarUrl: null };

const chloe: OfficeMember = { userId: "u3", name: "Chloé", avatarUrl: null };

const occupantOf = (member: OfficeMember, speaking: boolean): Occupant => ({
  userId: member.userId,
  displayName: member.name,
  avatarUrl: member.avatarUrl,
  speaking,
});

const IN_THE_OFFICE: ReadonlyArray<Occupant> = [
  occupantOf(anna, true),
  occupantOf(ben, false),
  occupantOf(chloe, false),
];

const runningSince = (startedAt: DateTime.Utc, isPaused: boolean): RunningRecording => ({
  id: "6a1f2c3e-4b5d-4e6f-8a7b-9c0d1e2f3a4b",
  startedAt,
  startedByName: anna.name,
  endsAt: DateTime.add(startedAt, { hours: 4 }),
  pause: isPaused ? { since: DateTime.add(startedAt, { minutes: 20 }), byName: ben.name } : null,
  title: "Deploy retro",
  agenda: "What broke\nWhat we change",
  summaryStyle: "brief",
});

const statusFor = (scenario: Scenario, now: DateTime.Utc): RecordingStatus => {
  const startedAt = DateTime.subtract(now, { minutes: 25 });

  return {
    botInOffice: scenario !== "away",
    occupants: scenario === "away" ? [] : IN_THE_OFFICE,
    recording: Match.value(scenario).pipe(
      Match.when("recording", () => runningSince(startedAt, false)),
      Match.when("paused", () => runningSince(startedAt, true)),
      Match.orElse(() => null),
    ),
    updatedAt: now,
  };
};

const LISTED: ReadonlyArray<ListedRecording> = [
  {
    id: "0b6e5b0e-1d7a-4c62-9f1e-3c1f8a2d4b51",
    state: "finished",
    startedAt: at("2026-11-20T09:30:00.000Z"),
    stoppedAt: at("2026-11-20T10:12:00.000Z"),
    startedBy: anna,
    speakers: [anna, ben, chloe],
    title: "Sprint planning",
  },
  {
    id: "4f3c2a1b-9e8d-4c7b-a6f5-e4d3c2b1a098",
    state: "finished",
    startedAt: at("2026-11-18T14:00:00.000Z"),
    stoppedAt: at("2026-11-18T14:31:00.000Z"),
    startedBy: ben,
    speakers: [ben, chloe],
    title: null,
  },
];

const detailOf = (listed: ListedRecording): RecordingDetail => ({
  ...listed,
  agenda: listed.title === null ? null : "Goals for the sprint\nWho takes what",
  stopReason: "requested",
  stoppedBy: listed.startedBy,
  summary: "• The deploy checklist gets a rollback step\n• Chloé pairs with Ben on the VPN",
  summaryModel: "a fake model",
  summaryStyle: "brief",
  summaryWrittenStyle: "brief",
  rewriting: false,
  slackPermalink: "https://example.slack.com/archives/C0/p1",
  clips: [
    {
      speaker: anna,
      startedAt: DateTime.add(listed.startedAt, { minutes: 1 }),
      text: "Morning all",
    },
    {
      speaker: ben,
      startedAt: DateTime.add(listed.startedAt, { minutes: 2 }),
      text: "Let's start with the deploy",
    },
  ],
  actionItems: [
    { id: 1, text: "add a rollback step to the deploy checklist", owner: anna, done: false },
    { id: 2, text: "pair on the VPN", owner: chloe, done: true },
  ],
  members: [anna, ben, chloe],
});

const statsFor = (range: OfficeStats["range"], now: DateTime.Utc): OfficeStats => ({
  range,
  since: range === "all" ? null : DateTime.subtract(now, { days: range === "week" ? 7 : 30 }),
  until: now,
  timeInOffice: [
    { userId: anna.userId, name: anna.name, seconds: 61_200, days: 5 },
    { userId: ben.userId, name: ben.name, seconds: 43_000, days: 4 },
    { userId: chloe.userId, name: chloe.name, seconds: 21_600, days: 2 },
  ],
  firstIn: [{ userId: anna.userId, name: anna.name, days: 4 }],
  lastOut: [{ userId: ben.userId, name: ben.name, days: 3 }],
  busiestHours: Array.flatMap([1, 2, 3, 4, 5], (weekday) =>
    Array.map([9, 10, 11, 14, 15], (hour) => ({ weekday, hour, people: (weekday + hour) % 4 })),
  ),
  sounds: [{ sound: "airhorn", plays: 12 }],
  players: [{ userId: ben.userId, name: ben.name, plays: 9 }],
  reactions: [{ emoji: "🎉", reactions: 7 }],
  recordings: { count: 2, seconds: 4_380 },
});

const consentFor = (scenario: Scenario, now: DateTime.Utc): ConsentStatus => ({
  standing: "agreed",
  since: DateTime.subtract(now, { days: 12 }),
  pendingWithdrawal: null,
  pendingErasure: null,
  refusedErasure: null,
  admin: scenario === "admin",
});

const casesFor = (now: DateTime.Utc): ReadonlyArray<ErasureCase> => [
  {
    id: 1,
    userId: "u9",
    displayName: "Dana",
    requestedAt: DateTime.subtract(now, { days: 3 }),
    dueAt: DateTime.add(now, { days: 27 }),
    decision: null,
    decidedBy: null,
    decidedByName: null,
    refusal: null,
    seenBy: [],
    seenByNames: [],
    inventory: {
      voiceActivity: 140,
      soundsAndEmoji: 12,
      slackMessages: 3,
      slackReactions: 5,
      clips: 40,
      audioFiles: 40,
      recordingsSpokenIn: 6,
      recordingsStartedStoppedOrPaused: 2,
      recordingRequests: 4,
      recordingEdits: 1,
      actionItemsOwned: 2,
      names: ["Dana"],
      linesMentioningThem: 9,
      recordingTextsMentioningThem: 2,
      slackPostsMentioningThem: 1,
      slackMessagesMentioningThem: 0,
    },
  },
];

const nextStatus = (
  status: RecordingStatus,
  submission: RequestSubmission,
  now: DateTime.Utc,
): RecordingStatus => {
  const recording = Match.value(submission.action).pipe(
    Match.when("start", () => ({
      ...runningSince(now, false),
      title: submission.title ?? null,
      agenda: submission.agenda ?? null,
      summaryStyle: submission.summaryStyle ?? "brief",
    })),
    Match.when("stop", () => null),
    Match.when("pause", () =>
      status.recording === null
        ? null
        : { ...status.recording, pause: { since: now, byName: anna.name } },
    ),
    Match.when("resume", () =>
      status.recording === null ? null : { ...status.recording, pause: null },
    ),
    Match.exhaustive,
  );

  return { ...status, recording, updatedAt: now };
};

const outcomeOf = (id: number, submission: RequestSubmission): HandledRequest =>
  Match.value(submission.action).pipe(
    Match.when("start", () => ({ id, outcome: "started" as const })),
    Match.when("stop", () => ({ id, outcome: "stopped" as const })),
    Match.when("pause", () => ({ id, outcome: "paused" as const })),
    Match.when("resume", () => ({ id, outcome: "resumed" as const })),
    Match.exhaustive,
  );

const BOT_THINKS_FOR = Duration.millis(600);

const officeGroups = (scenario: Scenario) =>
  Effect.gen(function* () {
    const status = yield* Ref.make(statusFor(scenario, yield* DateTime.now));
    const handled = yield* Ref.make(new Map<number, HandledRequest>());

    return {
      recording: HttpApiBuilder.group(RecordingApi, "recording", (handlers) =>
        handlers
          .handle("status", () => Ref.get(status))
          .handle("submit", ({ payload }) =>
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              const id = (yield* Ref.get(handled)).size + 1;

              yield* Effect.sleep(BOT_THINKS_FOR);
              yield* Ref.update(status, (current) => nextStatus(current, payload, now));
              yield* Ref.update(handled, (answers) =>
                new Map(answers).set(id, outcomeOf(id, payload)),
              );

              return { id, outcome: null };
            }),
          )
          .handle("find", ({ params }) =>
            Ref.get(handled).pipe(
              Effect.map((answers) => answers.get(params.id) ?? { id: params.id, outcome: null }),
            ),
          ),
      ),
      history: HttpApiBuilder.group(RecordingApi, "history", (handlers) =>
        handlers
          .handle("recordings", () => Effect.succeed({ recordings: LISTED, older: null }))
          .handle("recording", ({ params }) =>
            Option.match(
              Array.findFirst(LISTED, ({ id }) => id === params.id),
              {
                onNone: () => Effect.fail(RecordingNotFound.make()),
                onSome: (listed) => Effect.succeed(detailOf(listed)),
              },
            ),
          ),
      ),
      stats: HttpApiBuilder.group(RecordingApi, "stats", (handlers) =>
        handlers.handle("office", ({ query }) =>
          DateTime.now.pipe(Effect.map((now) => statsFor(query.range, now))),
        ),
      ),
      edits: HttpApiBuilder.group(RecordingApi, "edits", (handlers) =>
        handlers
          .handle("submit", () => Effect.succeed({ id: 1, outcome: null }))
          .handle("find", ({ params }) =>
            Effect.succeed({ id: params.id, outcome: "applied" as const }),
          ),
      ),
      consent: HttpApiBuilder.group(RecordingApi, "consent", (handlers) =>
        handlers
          .handle("status", () => DateTime.now.pipe(Effect.map((now) => consentFor(scenario, now))))
          .handle("withdraw", () => Effect.succeed({ id: 1, outcome: "withdrawn" as const }))
          .handle("find", ({ params }) =>
            Effect.succeed({ id: params.id, outcome: "withdrawn" as const }),
          )
          .handle("erase", () =>
            DateTime.now.pipe(
              Effect.map((now) => ({
                id: 1,
                outcome: null,
                dueAt: DateTime.add(now, { days: 30 }),
              })),
            ),
          )
          .handle("findErasure", ({ params }) =>
            DateTime.now.pipe(
              Effect.map((now) => ({
                id: params.id,
                outcome: null,
                dueAt: DateTime.add(now, { days: 30 }),
              })),
            ),
          )
          .handle("cancelErasure", ({ params }) =>
            DateTime.now.pipe(
              Effect.map((now) => ({ id: params.id, outcome: "cancelled" as const, dueAt: now })),
            ),
          ),
      ),
      erasureAdmin: HttpApiBuilder.group(RecordingApi, "erasureAdmin", (handlers) =>
        handlers
          .handle("cases", () => DateTime.now.pipe(Effect.map(casesFor)))
          .handle("expedite", ({ params }) =>
            DateTime.now.pipe(Effect.map((now) => ({ id: params.id, outcome: null, dueAt: now }))),
          )
          .handle("seen", ({ params }) =>
            DateTime.now.pipe(
              Effect.map((now) => ({
                id: params.id,
                outcome: null,
                dueAt: DateTime.add(now, { days: 27 }),
              })),
            ),
          )
          .handle("refuse", ({ params }) =>
            DateTime.now.pipe(
              Effect.map((now) => ({ id: params.id, outcome: "refused" as const, dueAt: now })),
            ),
          ),
      ),
    };
  });

const discordInTheBrowser: DiscordClient = {
  ready: () => Promise.resolve(),
  commands: {
    authorize: () => Promise.resolve({ code: "fake-code" }),
    authenticate: ({ access_token }) =>
      Promise.resolve({
        access_token: access_token ?? "",
        user: { id: "u1", username: "anna", discriminator: "0", public_flags: 0, avatar: null },
        scopes: ["identify", "rpc.activities.write"],
        expires: "2099-01-01T00:00:00Z",
        application: { id: "client-1", name: "Console", description: "" },
      }),
    setActivity: ({ activity }) => Promise.resolve({ ...activity, type: 0, name: "Console" }),
    openExternalLink: ({ url }) => {
      globalThis.open(url, "_blank", "noopener");

      return Promise.resolve({ opened: true });
    },
  },
};

export const fakeOfficeResources = (scenario: Scenario) =>
  fakeResources(fakeWorker(Effect.runSync(officeGroups(scenario))).layer, discordInTheBrowser);
