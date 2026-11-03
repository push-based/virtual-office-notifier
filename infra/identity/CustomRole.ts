import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { Array, Effect, Order } from "effect";

import { untilPresent } from "./Eventually.ts";

export type CustomRoleProps = {
  readonly project: string;
  readonly roleId: string;
  readonly title: string;
  readonly description: string;
  readonly permissions: ReadonlyArray<string>;
};

export type CustomRole = Resource<
  "VirtualOffice.CustomRole",
  CustomRoleProps,
  { readonly name: string }
>;

export const CustomRole = Resource<CustomRole>("VirtualOffice.CustomRole");

const nameOf = (props: CustomRoleProps) => `projects/${props.project}/roles/${props.roleId}`;

const find = (name: string) =>
  iam.getProjectsRoles({ name }).pipe(
    Effect.map((role) => (role.deleted === true ? undefined : role)),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const sorted = (permissions: ReadonlyArray<string>) => Array.sort(permissions, Order.String);

const differs = (current: iam.Role, wanted: CustomRoleProps) =>
  current.title !== wanted.title ||
  (current.description ?? "") !== wanted.description ||
  Array.join(sorted(current.includedPermissions ?? []), ",") !==
    Array.join(sorted(wanted.permissions), ",");

export const CustomRoleProvider = () =>
  Provider.succeed(CustomRole, {
    stables: ["name"],

    diff: ({ news, olds }) =>
      Effect.succeed(
        isResolved(news) &&
          olds !== undefined &&
          (news.project !== olds.project || news.roleId !== olds.roleId)
          ? { action: "replace" as const, deleteFirst: false }
          : undefined,
      ),

    read: Effect.fn(function* ({ olds, output }) {
      const name = output?.name ?? (olds === undefined ? undefined : nameOf(olds));

      if (name === undefined) return undefined;
      const role = yield* find(name);

      return role === undefined ? undefined : { name };
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const name = nameOf(news);
      const existing = yield* find(name);

      const role = {
        title: news.title,
        description: news.description,
        includedPermissions: [...news.permissions],
        stage: "GA",
      };

      if (existing === undefined) {
        yield* iam.createProjectsRoles({
          parent: `projects/${news.project}`,
          body: { roleId: news.roleId, role },
        });
      } else if (differs(existing, news)) {
        yield* iam.patchProjectsRoles({
          name,
          updateMask: "title,description,includedPermissions",
          body: role,
        });
      }

      yield* untilPresent(name, find(name));

      return { name };
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* iam
        .deleteProjectsRoles({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
