import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { Array, Effect, Order } from "effect";

import { untilPresent } from "./Eventually.ts";

export type AttributeMapping = Readonly<Record<string, string>>;

export type OidcProviderProps = {
  readonly pool: string;
  readonly providerId: string;
  readonly issuerUri: string;
  readonly attributeMapping: AttributeMapping;
  readonly attributeCondition: string;
};

export type OidcProvider = Resource<
  "VirtualOffice.OidcProvider",
  OidcProviderProps,
  { readonly name: string }
>;

export const OidcProvider = Resource<OidcProvider>("VirtualOffice.OidcProvider");

const nameOf = (props: OidcProviderProps) => `${props.pool}/providers/${props.providerId}`;

const find = (name: string) =>
  iam
    .getProjectsLocationsWorkloadIdentityPoolsProviders({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const canonical = (mapping: Readonly<Record<string, string | undefined>>) =>
  Array.join(
    Array.sort(
      Array.map(Object.entries(mapping), ([key, value]) => `${key}=${value ?? ""}`),
      Order.String,
    ),
    ",",
  );

const differs = (current: iam.WorkloadIdentityPoolProvider, wanted: OidcProviderProps) =>
  current.oidc?.issuerUri !== wanted.issuerUri ||
  current.attributeCondition !== wanted.attributeCondition ||
  canonical(current.attributeMapping ?? {}) !== canonical(wanted.attributeMapping);

export const OidcProviderProvider = () =>
  Provider.succeed(OidcProvider, {
    stables: ["name"],

    diff: ({ news, olds }) =>
      Effect.succeed(
        isResolved(news) &&
          olds !== undefined &&
          (news.pool !== olds.pool || news.providerId !== olds.providerId)
          ? { action: "replace" as const, deleteFirst: false }
          : undefined,
      ),

    read: Effect.fn(function* ({ olds, output }) {
      const name = output?.name ?? (olds === undefined ? undefined : nameOf(olds));

      if (name === undefined) return undefined;
      const provider = yield* find(name);

      return provider === undefined ? undefined : { name };
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const name = nameOf(news);
      const existing = yield* find(name);

      const body = {
        oidc: { issuerUri: news.issuerUri },
        attributeMapping: { ...news.attributeMapping },
        attributeCondition: news.attributeCondition,
      };

      if (existing === undefined) {
        yield* iam.createProjectsLocationsWorkloadIdentityPoolsProviders({
          parent: news.pool,
          workloadIdentityPoolProviderId: news.providerId,
          body,
        });
      } else if (differs(existing, news)) {
        yield* iam.patchProjectsLocationsWorkloadIdentityPoolsProviders({
          name,
          updateMask: "oidc,attributeMapping,attributeCondition",
          body,
        });
      }

      yield* untilPresent(name, find(name));

      return { name };
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* iam
        .deleteProjectsLocationsWorkloadIdentityPoolsProviders({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
