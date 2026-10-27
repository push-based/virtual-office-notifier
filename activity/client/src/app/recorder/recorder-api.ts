import { HttpClient } from "@angular/common/http";
import { Service, inject } from "@angular/core";
import type { Observable } from "rxjs";

import type { RecordingAction, RecordingStatus, RequestResult } from "./models";

@Service()
export class RecorderApi {
  private readonly http = inject(HttpClient);

  state(): Observable<RecordingStatus> {
    return this.http.get<RecordingStatus>("/api/state");
  }

  requestRecording(action: RecordingAction): Observable<RequestResult> {
    return this.http.post<RequestResult>("/api/recording", { action });
  }

  requestResult(id: number): Observable<RequestResult> {
    return this.http.get<RequestResult>(`/api/requests/${id}`);
  }
}
