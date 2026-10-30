import type { ListedRecording, OfficeMember, RecordingDetail } from "./models";

export const anna: OfficeMember = { userId: "u1", name: "Anna", avatarUrl: null };

export const ben: OfficeMember = {
  userId: "u2",
  name: "Ben",
  avatarUrl: "https://cdn.example/ben.png",
};

export const listedRecording = (overrides: Partial<ListedRecording> = {}): ListedRecording => ({
  id: "r1",
  state: "finished",
  startedAt: "2026-10-29T12:05:00.000Z",
  stoppedAt: "2026-10-29T13:17:00.000Z",
  startedBy: anna,
  speakers: [anna, ben],
  title: null,
  ...overrides,
});

export const recordingDetail = (overrides: Partial<RecordingDetail> = {}): RecordingDetail => ({
  ...listedRecording(),
  agenda: null,
  stopReason: "requested",
  stoppedBy: anna,
  summary: "• Anna said hello",
  summaryModel: "model",
  summaryStyle: "brief",
  summaryWrittenStyle: "brief",
  rewriting: false,
  slackPermalink: "https://office.slack.com/archives/C1/p12",
  clips: [
    { speaker: anna, startedAt: "2026-10-29T12:06:00.000Z", text: "Hello" },
    { speaker: anna, startedAt: "2026-10-29T12:06:10.000Z", text: "Anyone there?" },
    { speaker: ben, startedAt: "2026-10-29T12:07:00.000Z", text: "Morning" },
  ],
  actionItems: [
    { id: 4, text: "write up the deploy checklist", owner: anna, done: false },
    { id: 5, text: "ask IT about the VPN", owner: null, done: false },
    { id: 6, text: "book the room for Thursday", owner: ben, done: true },
  ],
  members: [anna, ben],
  ...overrides,
});
