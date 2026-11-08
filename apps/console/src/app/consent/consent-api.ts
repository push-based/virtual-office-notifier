import { HttpClient } from "@angular/common/http";
import { Service, inject } from "@angular/core";
import type {
  ConsentStatus,
  ErasureCase,
  ErasureRefusal,
  SubmittedErasure,
  SubmittedWithdrawal,
} from "recording-requests/wire";
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

  cancelErasure(id: number): Observable<SubmittedErasure> {
    return this.http.post<SubmittedErasure>(`/api/consent/erasures/${id}/cancel`, null);
  }

  cases(): Observable<ReadonlyArray<ErasureCase>> {
    return this.http.get<ReadonlyArray<ErasureCase>>("/api/admin/erasures");
  }

  expedite(id: number): Observable<SubmittedErasure> {
    return this.http.post<SubmittedErasure>(`/api/admin/erasures/${id}/now`, null);
  }

  seen(id: number): Observable<SubmittedErasure> {
    return this.http.post<SubmittedErasure>(`/api/admin/erasures/${id}/seen`, null);
  }

  refuse(id: number, refusal: ErasureRefusal): Observable<SubmittedErasure> {
    return this.http.post<SubmittedErasure>(`/api/admin/erasures/${id}/refuse`, refusal);
  }
}
