import { HttpClient } from "@angular/common/http";
import { Service, inject } from "@angular/core";
import type { OfficeStats, StatsRange } from "recording-requests/wire";
import type { Observable } from "rxjs";

@Service()
export class StatsApi {
  private readonly http = inject(HttpClient);

  stats(range: StatsRange): Observable<OfficeStats> {
    return this.http.get<OfficeStats>("/api/stats", { params: { range } });
  }
}
