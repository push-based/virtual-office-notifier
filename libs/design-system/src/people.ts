import type { Html, HtmlBuilder } from "foldkit/html";

import { eyebrow } from "./text.ts";
import { initials } from "./initials.ts";

export interface Person {
  readonly id: string;
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly speaking?: boolean;
}

export interface AvatarConfig {
  readonly name: string;
  readonly src: string | null;
  readonly isSpeaking?: boolean;
  readonly size?: AvatarSize;
}

export type AvatarSize = "sm" | "md";

const avatarClass = (config: AvatarConfig): string =>
  [
    "pb-avatar",
    ...(config.size === "sm" ? ["pb-avatar-sm"] : []),
    ...(config.isSpeaking === true ? ["pb-avatar-speaking"] : []),
  ].join(" ");

export const avatar = <Message>(h: HtmlBuilder<Message>, config: AvatarConfig): Html =>
  h.span(
    [h.Class(avatarClass(config)), h.Title(config.name)],
    [
      config.src === null
        ? h.span(
            [h.Class("text-caption pb-avatar-initials"), h.Role("img"), h.AriaLabel(config.name)],
            [initials(config.name)],
          )
        : h.img([h.Src(config.src), h.Alt(config.name)]),
    ],
  );

export interface PeopleConfig {
  readonly id: string;
  readonly people: ReadonlyArray<Person>;
  readonly label?: string;
}

export const people = <Message>(h: HtmlBuilder<Message>, config: PeopleConfig): Html => {
  const labelId = `${config.id}-label`;

  return h.div(
    [h.Class("pb-avatar-group")],
    [
      config.label === undefined
        ? h.empty
        : eyebrow(h, { text: config.label, tone: "muted", id: labelId }),
      h.ul(
        config.label === undefined ? [] : [h.AriaLabelledBy(labelId)],
        config.people.map((person) =>
          h.keyed("li")(
            person.id,
            [],
            [
              avatar(h, {
                name: person.name,
                src: person.avatarUrl,
                isSpeaking: person.speaking ?? false,
              }),
            ],
          ),
        ),
      ),
    ],
  );
};
