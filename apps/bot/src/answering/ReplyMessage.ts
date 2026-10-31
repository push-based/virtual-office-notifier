import { Option } from "effect";

import {
  AI_DISCLAIMER,
  context,
  escapeSlackText,
  headline,
  type SlackMessage,
} from "../slack/index.ts";

export const replyMessage = (text: string, model: string): SlackMessage => {
  const escaped = escapeSlackText(text);

  return {
    text: escaped,
    blocks: [
      headline(escaped, Option.none()),
      context(`Reply by ${escapeSlackText(model)}`, AI_DISCLAIMER),
    ],
  };
};
