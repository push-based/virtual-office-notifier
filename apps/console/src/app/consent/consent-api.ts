import { HttpClient } from "@angular/common/http";
import { Service, inject } from "@angular/core";
import type { ConsentStatus, SubmittedErasure, SubmittedWithdrawal } from "recording-requests/wire";
import type { Observable } from "rxjs";

@Service()
export class ConsentApi {
  private readonly http = inject(HttpClient);

  status(): Observable<ConsentStatus> {
    return this.http.get<ConsentStatus>("/api/consent");
  }

  withdraw(): Observable<SubmittedWithdrawal> {
    return this.http.post<SubmittedWithdrawal>("/api/consent/withdrawals", null);
  }

  find(id: number): Observable<SubmittedWithdrawal> {
    return this.http.get<SubmittedWithdrawal>(`/api/consent/withdrawals/${id}`);
  }

  erase(): Observable<SubmittedErasure> {
    return this.http.post<SubmittedErasure>("/api/consent/erasures", null);
  }

  findErasure(id: number): Observable<SubmittedErasure> {
    return this.http.get<SubmittedErasure>(`/api/consent/erasures/${id}`);
  }
}
