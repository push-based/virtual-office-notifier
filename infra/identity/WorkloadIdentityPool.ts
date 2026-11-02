import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { Effect } from "effect";

import { untilPresent } from "./Eventually.ts";

export type WorkloadIdentityPoolProps = {
  readonly project: string;
  readonly poolId: string;
  readonly displayName: string;
};

export type WorkloadIdentityPool = Resource<
  "VirtualOffice.WorkloadIdentityPool",
  WorkloadIdentityPoolProps,
  {
    readonly name: string;
    readonly projectNumber: string;
    readonly displayName: string;
  }
>;

export const WorkloadIdentityPool = Resource<WorkloadIdentityPool>(
  "VirtualOffice.WorkloadIdentityPool",
);

const nameOf = (props: WorkloadIdentityPoolProps) =>
  `projects/${props.project}/locations/global/workloadIdentityPools/${props.poolId}`;

const find = (name: string) =>
  iam
    .getProjectsLocationsWorkloadIdentityPools({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toAttributes = (pool: iam.WorkloadIdentityPool, name: string) => ({
  name: pool.name ?? name,
  projectNumber: (pool.name ?? name).split("/")[1] ?? "",
  displayName: pool.displayName ?? "",
});

export const WorkloadIdentityPoolProvider = () =>
  Provider.succeed(WorkloadIdentityPool, {
    stables: ["name", "projectNumber"],

    diff: ({ news, olds }) =>
      Effect.succeed(
        isResolved(news) &&
          olds !== undefined &&
          (news.project !== olds.project || news.poolId !== olds.poolId)
          ? { action: "replace" as const, deleteFirst: false }
          : undefined,
      ),

    read: Effect.fn(function* ({ olds, output }) {
      const name = output?.name ?? (olds === undefined ? undefined : nameOf(olds));

      if (name === undefined) return undefined;
      const pool = yield* find(name);

      return pool === undefined ? undefined : toAttributes(pool, name);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const name = nameOf(news);
      const existing = yield* find(name);

      if (existing === undefined) {
        yield* iam.createProjectsLocationsWorkloadIdentityPools({
          parent: `projects/${news.project}/locations/global`,
          workloadIdentityPoolId: news.poolId,
          body: { displayName: news.displayName },
        });
      } else if ((existing.displayName ?? "") !== news.displayName) {
        yield* iam.patchProjectsLocationsWorkloadIdentityPools({
          name,
          updateMask: "displayName",
          body: { displayName: news.displayName },
        });
      }

      const pool = yield* untilPresent(name, find(name));

      return { ...toAttributes(pool, name), displayName: news.displayName };
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* iam
        .deleteProjectsLocationsWorkloadIdentityPools({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
