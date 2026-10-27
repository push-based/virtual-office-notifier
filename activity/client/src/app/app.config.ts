import { provideHttpClient, withInterceptors } from "@angular/common/http";
import { type ApplicationConfig, provideBrowserGlobalErrorListeners } from "@angular/core";

import { apiErrorInterceptor, sessionInterceptor } from "./recorder/interceptors";

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withInterceptors([sessionInterceptor, apiErrorInterceptor])),
  ],
};
