import { HttpClient } from "@angular/common/http";
import { InjectionToken, Service, inject, signal } from "@angular/core";
import { DiscordSDK } from "@discord/embedded-app-sdk";
import { firstValueFrom } from "rxjs";

export type DiscordClient = Pick<DiscordSDK, "ready"> & {
  readonly commands: Pick<DiscordSDK["commands"], "authorize" | "authenticate">;
};

export const DISCORD_CLIENT = new InjectionToken<(clientId: string) => DiscordClient>("DiscordClient", {
  providedIn: "root",
  factory: () => (clientId) => new DiscordSDK(clientId),
});

interface ConfigResponse {
  readonly clientId: string;
}

interface TokenResponse {
  readonly accessToken: string;
  readonly session: string;
}

@Service()
export class RecorderSession {
  private readonly http = inject(HttpClient);

  private readonly createDiscordClient = inject(DISCORD_CLIENT);

  private readonly current = signal<string | null>(null);

  readonly token = this.current.asReadonly();

  async signIn(): Promise<void> {
    const { clientId } = await firstValueFrom(this.http.get<ConfigResponse>("/api/config"));
    const discord = this.createDiscordClient(clientId);

    await discord.ready();

    const { code } = await discord.commands.authorize({
      client_id: clientId,
      response_type: "code",
      state: "",
      prompt: "none",
      scope: ["identify"],
    });

    const token = await firstValueFrom(this.http.post<TokenResponse>("/api/token", { code }));

    this.current.set(token.session);

    await discord.commands.authenticate({ access_token: token.accessToken });
  }
}
