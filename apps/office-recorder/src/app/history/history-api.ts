import { HttpClient, HttpParams } from "@angular/common/http";
import { Service, inject } from "@angular/core";
import type { Observable } from "rxjs";

import type { RecordingDetail, RecordingPage } from "./models";

@Service()
export class HistoryApi {
  private readonly http = inject(HttpClient);

  page(before: string | null): Observable<RecordingPage> {
    const params = before === null ? new HttpParams() : new HttpParams().set("before", before);

    return this.http.get<RecordingPage>("/api/recordings", { params });
  }

  recording(id: string): Observable<RecordingDetail> {
    return this.http.get<RecordingDetail>(`/api/recordings/${encodeURIComponent(id)}`);
  }
}
