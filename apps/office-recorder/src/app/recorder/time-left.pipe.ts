import { Pipe, type PipeTransform } from "@angular/core";

@Pipe({ name: "timeLeft" })
export class TimeLeftPipe implements PipeTransform {
  transform(until: string, now: number): string {
    const minutes = Math.max(0, Math.ceil((Date.parse(until) - now) / 60_000));

    return minutes >= 60
      ? `${Math.floor(minutes / 60)}h ${minutes % 60}m left`
      : `${minutes}m left`;
  }
}
