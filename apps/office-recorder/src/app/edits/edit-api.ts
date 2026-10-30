import { HttpClient } from "@angular/common/http";
import { Service, inject } from "@angular/core";
import type { Observable } from "rxjs";

import type { RecordingChange, SubmittedEdit } from "./models";

@Service()
export class EditApi {
  private readonly http = inject(HttpClient);

  submit(recordingId: string, change: RecordingChange): Observable<SubmittedEdit> {
    return this.http.post<SubmittedEdit>(
      `/api/recordings/${encodeURIComponent(recordingId)}/edits`,
      change,
    );
  }

  find(id: number): Observable<SubmittedEdit> {
    return this.http.get<SubmittedEdit>(`/api/edits/${id}`);
  }
}
