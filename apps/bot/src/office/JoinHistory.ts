import {
  NetworkingStatusCode,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
} from "@discordjs/voice";

export const JOIN_HISTORY_LIMIT = 40;

const NETWORKING_STEPS: Record<NetworkingStatusCode, string> = {
  [NetworkingStatusCode.OpeningWs]: "opening the voice WebSocket",
  [NetworkingStatusCode.Identifying]: "identifying",
  [NetworkingStatusCode.UdpHandshaking]: "UDP handshake",
  [NetworkingStatusCode.SelectingProtocol]: "selecting the protocol",
  [NetworkingStatusCode.Ready]: "ready",
  [NetworkingStatusCode.Resuming]: "resuming",
  [NetworkingStatusCode.Closed]: "closed",
};

const DISCONNECT_REASONS: Record<VoiceConnectionDisconnectReason, string> = {
  [VoiceConnectionDisconnectReason.WebSocketClose]: "voice WebSocket closed",
  [VoiceConnectionDisconnectReason.AdapterUnavailable]: "Discord gateway unavailable",
  [VoiceConnectionDisconnectReason.EndpointRemoved]: "voice server removed",
  [VoiceConnectionDisconnectReason.Manual]: "disconnected on purpose",
};

export interface ConnectionProgress {
  readonly status: VoiceConnectionStatus;
  readonly networking?: { readonly state: { readonly code: NetworkingStatusCode } };
  readonly reason?: VoiceConnectionDisconnectReason;
  readonly closeCode?: number;
}

const disconnectDetail = (
  reason: VoiceConnectionDisconnectReason,
  closeCode: number | undefined,
): string =>
  closeCode === undefined
    ? DISCONNECT_REASONS[reason]
    : `${DISCONNECT_REASONS[reason]} with ${closeCode}`;

export const connectionStep = ({
  status,
  networking,
  reason,
  closeCode,
}: ConnectionProgress): string => {
  if (networking !== undefined) return `${status} (${NETWORKING_STEPS[networking.state.code]})`;

  if (reason !== undefined) return `${status} (${disconnectDetail(reason, closeCode)})`;

  return status;
};

export const describeVoiceServer = ({ endpoint }: { readonly endpoint: string | null }): string =>
  endpoint === null
    ? "Discord sent the voice server without an endpoint"
    : "Discord sent the voice server";

export const describeVoiceState = ({
  channel_id,
}: {
  readonly channel_id: string | null;
}): string =>
  channel_id === null
    ? "Discord sent the voice state, out of the channel"
    : "Discord sent the voice state, in the channel";

export interface JoinHistory {
  readonly record: (event: string) => void;
  readonly step: (progress: ConnectionProgress) => void;
  readonly entries: () => ReadonlyArray<string>;
}

export const startJoinHistory = (now: () => number, limit = JOIN_HISTORY_LIMIT): JoinHistory => {
  const startedAt = now();
  let entries: ReadonlyArray<string> = [];
  let lastStep = "";

  const record = (event: string) => {
    entries = [...entries, `+${now() - startedAt}ms ${event}`].slice(-limit);
  };

  const step = (progress: ConnectionProgress) => {
    const described = connectionStep(progress);

    if (described === lastStep) return;

    lastStep = described;
    record(described);
  };

  return { record, step, entries: () => entries };
};
