import { Array, Option, pipe, String } from "effect";

export const initials = (name: string): string =>
  pipe(
    name,
    String.split(/\s+/),
    Array.take(2),
    Array.map((part) =>
      pipe(
        part,
        String.charAt(0),
        Option.map(String.toUpperCase),
        Option.getOrElse(() => ""),
      ),
    ),
    Array.join(""),
  );
