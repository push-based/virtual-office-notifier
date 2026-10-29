import { String } from "effect";

export const columnNaming = {
  transformQueryNames: String.camelToSnake,
  transformResultNames: String.snakeToCamel,
};
