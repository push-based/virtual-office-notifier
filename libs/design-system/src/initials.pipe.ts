import { Pipe, type PipeTransform } from "@angular/core";

@Pipe({ name: "initials" })
export class InitialsPipe implements PipeTransform {
  transform(name: string): string {
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("");
  }
}
