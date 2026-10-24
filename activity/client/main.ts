import { DiscordSDK } from "@discord/embedded-app-sdk";

interface Occupant {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
}

interface RecordingStatus {
  readonly botInOffice: boolean;
  readonly occupants: ReadonlyArray<Occupant>;
  readonly recording: {
    readonly id: string;
    readonly startedAt: string;
    readonly startedByName: string;
    readonly endsAt: string;
  } | null;
}

interface RequestResult {
  readonly id: number;
  readonly handled: boolean;
  readonly outcome: "started" | "stopped" | "ignored" | null;
  readonly reason: string | null;
  readonly reasonText: string | null;
}

interface TokenResponse {
  readonly accessToken: string;
  readonly session: string;
  readonly user: { readonly id: string; readonly name: string; readonly avatarUrl: string | null };
}

const STATE_INTERVAL_MS = 3000;

const REQUEST_POLL_MS = 1000;

const REQUEST_POLL_LIMIT = 15;

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);

  if (found === null) throw new Error(`Missing element #${id}`);

  // SAFETY: the ids are fixed in index.html next to this file, each on the element type asked for.
  return found as T;
};

const button = element<HTMLButtonElement>("record");

const buttonLabel = element<HTMLSpanElement>("record-label");

const status = element<HTMLParagraphElement>("status");

const detail = element<HTMLParagraphElement>("detail");

const notice = element<HTMLParagraphElement>("notice");

const occupantsList = element<HTMLUListElement>("occupants");

let session = "";

let current: RecordingStatus | null = null;

let busy = false;

let noticeTimer: ReturnType<typeof setTimeout> | undefined;

const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${session}`, ...init.headers },
  });

  if (!response.ok) throw new Error(`${path} answered ${response.status}`);

  // SAFETY: the Worker in ../server/index.ts writes these bodies from the same shared schemas.
  return (await response.json()) as T;
};

const showNotice = (text: string, kind: "info" | "error" = "info") => {
  notice.textContent = text;
  notice.dataset["kind"] = kind;
  notice.hidden = false;

  if (noticeTimer !== undefined) clearTimeout(noticeTimer);

  noticeTimer = setTimeout(() => {
    notice.hidden = true;
  }, 6000);
};

const pad = (value: number): string => String(value).padStart(2, "0");

const clock = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
};

const remaining = (ms: number): string => {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));

  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m left` : `${minutes}m left`;
};

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

const renderOccupants = (occupants: ReadonlyArray<Occupant>) => {
  occupantsList.replaceChildren(
    ...occupants.map((occupant) => {
      const item = document.createElement("li");
      item.title = occupant.displayName;

      if (occupant.avatarUrl === null) {
        item.textContent = initials(occupant.displayName);
      } else {
        const image = document.createElement("img");
        image.src = occupant.avatarUrl;
        image.alt = occupant.displayName;
        item.append(image);
      }

      return item;
    }),
  );
};

const render = () => {
  if (current === null) return;

  const now = Date.now();
  const recording = current.recording;

  document.body.dataset["recording"] = recording === null ? "off" : "on";
  button.disabled = busy || !current.botInOffice;
  buttonLabel.textContent = recording === null ? "Start" : "Stop";

  if (recording === null) {
    status.textContent = current.botInOffice ? "Not recording" : "The bot isn't in the office yet";
    detail.textContent = current.botInOffice
      ? "Press start to record and transcribe the office."
      : "It joins once someone is in the voice channel.";
  } else {
    const started = Date.parse(recording.startedAt);
    const ends = Date.parse(recording.endsAt);

    status.textContent = `Recording · ${clock(now - started)}`;
    detail.textContent = `Started by ${recording.startedByName} · ${remaining(ends - now)}`;
  }

  renderOccupants(current.occupants);
};

const refresh = async () => {
  try {
    current = await api<RecordingStatus>("/api/state");
    render();
  } catch (error) {
    showNotice(`Couldn't reach the bot: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const awaitOutcome = async (id: number): Promise<RequestResult | null> => {
  for (let attempt = 0; attempt < REQUEST_POLL_LIMIT; attempt += 1) {
    await sleep(REQUEST_POLL_MS);

    const result = await api<RequestResult>(`/api/requests/${id}`);

    if (result.handled) return result;
  }

  return null;
};

const press = async () => {
  if (busy || current === null) return;

  busy = true;
  render();

  const action = current.recording === null ? "start" : "stop";

  try {
    const requested = await api<RequestResult>("/api/recording", { method: "POST", body: JSON.stringify({ action }) });
    const result = await awaitOutcome(requested.id);

    if (result === null) {
      showNotice("The bot hasn't answered yet. Try again in a moment.", "error");
    } else if (result.outcome === "ignored") {
      showNotice(result.reasonText ?? "The bot couldn't do that right now.", "error");
    } else {
      showNotice(result.outcome === "started" ? "Recording started." : "Recording stopped. The summary lands in Slack once it's transcribed.");
    }
  } catch (error) {
    showNotice(`Couldn't reach the bot: ${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    busy = false;
    await refresh();
  }
};

const start = async () => {
  const { clientId } = await api<{ readonly clientId: string }>("/api/config");
  const sdk = new DiscordSDK(clientId);

  await sdk.ready();

  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: ["identify"],
  });

  const token = await api<TokenResponse>("/api/token", { method: "POST", body: JSON.stringify({ code }) });

  session = token.session;

  await sdk.commands.authenticate({ access_token: token.accessToken });

  button.addEventListener("click", () => {
    void press();
  });

  await refresh();
  setInterval(() => void refresh(), STATE_INTERVAL_MS);
  setInterval(render, 1000);
};

const showFailure = (error: Error) => {
  status.textContent = "Couldn't start";
  detail.textContent = error.message;
};

start().catch(showFailure);
