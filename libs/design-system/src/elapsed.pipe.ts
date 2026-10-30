import { Pipe, type PipeTransform } from "@angular/core";

const pad = (value: number): string => String(value).padStart(2, "0");

@Pipe({ name: "elapsed" })
export class ElapsedPipe implements PipeTransform {
  transform(since: string, now: number): string {
    const total = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;

    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
}
