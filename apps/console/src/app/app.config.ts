import { provideHttpClient, withInterceptors } from "@angular/common/http";
import { type ApplicationConfig, provideBrowserGlobalErrorListeners } from "@angular/core";

import { apiErrorInterceptor, retryInterceptor, sessionInterceptor } from "./recorder/interceptors";
import { provideTelemetry } from "./telemetry/telemetry";

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(
      withInterceptors([sessionInterceptor, apiErrorInterceptor, retryInterceptor]),
    ),
    provideTelemetry(),
  ],
};
