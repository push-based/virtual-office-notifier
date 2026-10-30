import { HttpClient } from "@angular/common/http";
import { Service, inject } from "@angular/core";
import type { Observable } from "rxjs";

import type { Plan } from "../edits/plan";
import type { RecordingStatus, RequestAction, RequestSubmission, SubmittedRequest } from "./models";

@Service()
export class RecorderApi {
  private readonly http = inject(HttpClient);

  status(): Observable<RecordingStatus> {
    return this.http.get<RecordingStatus>("/api/status");
  }

  submit(action: RequestAction, plan?: Plan): Observable<SubmittedRequest> {
    const body: RequestSubmission =
      plan === undefined ? { action } : { action, title: plan.title, agenda: plan.agenda };

    return this.http.post<SubmittedRequest>("/api/requests", body);
  }

  find(id: number): Observable<SubmittedRequest> {
    return this.http.get<SubmittedRequest>(`/api/requests/${id}`);
  }
}
