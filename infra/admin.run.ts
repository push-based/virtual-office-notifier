import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GCP from "@alchemy.run/gcp";
import * as GitHub from "@alchemy.run/github";
import { RemovalPolicy, Stack } from "alchemy";
import * as Output from "alchemy/Output";
import { Effect, Layer, Redacted } from "effect";

import { CustomRole, CustomRoleProvider } from "./identity/CustomRole.ts";
import { OidcProvider, OidcProviderProvider } from "./identity/OidcProvider.ts";
import {
  WorkloadIdentityPool,
  WorkloadIdentityPoolProvider,
} from "./identity/WorkloadIdentityPool.ts";

const PROJECT = "virtual-office-notifier";

const OWNER = "push-based";

const REPOSITORY = "virtual-office-notifier";

const VM = `projects/${PROJECT}/zones/us-central1-a/instances/virtual-office-notifier`;

const VM_SERVICE_ACCOUNT = "132656138437-compute@developer.gserviceaccount.com";

const RECORDINGS_BUCKET = "virtual-office-notifier-recordings";

const identityProviders = Layer.mergeAll(
  WorkloadIdentityPoolProvider(),
  OidcProviderProvider(),
  CustomRoleProvider(),
).pipe(Layer.provideMerge(GCP.providers()));

export default Stack(
  "virtual-office-admin",
  {
    providers: Layer.mergeAll(identityProviders, GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const deployer = yield* GCP.IAM.ServiceAccount("Deployer", {
      project: PROJECT,
      accountId: "github-deploy",
      displayName: "GitHub Actions deploy",
    }).pipe(RemovalPolicy.retain());

    const pool = yield* WorkloadIdentityPool("GitHubPool", {
      project: PROJECT,
      poolId: "github",
      displayName: "GitHub Actions",
    }).pipe(RemovalPolicy.retain());

    const oidc = yield* OidcProvider("GitHubOidc", {
      pool: pool.name,
      providerId: "github",
      issuerUri: "https://token.actions.githubusercontent.com",
      attributeMapping: {
        "google.subject": "assertion.sub",
        "attribute.repository": "assertion.repository",
        "attribute.ref": "assertion.ref",
      },
      attributeCondition: `assertion.repository == '${OWNER}/${REPOSITORY}' && assertion.ref == 'refs/heads/main'`,
    }).pipe(RemovalPolicy.retain());

    const projectReader = yield* CustomRole("ProjectReader", {
      project: PROJECT,
      roleId: "githubDeployProjectReader",
      title: "GitHub deploy project reader",
      description: "Lets gcloud compute ssh/scp read project metadata",
      permissions: ["compute.projects.get"],
    }).pipe(RemovalPolicy.retain());

    const deployerMember = Output.interpolate`serviceAccount:${deployer.email}`;

    yield* GCP.IAM.Member("MainBranchActsAsDeployer", {
      kind: "iam.serviceAccount",
      name: deployer.name,
      role: "roles/iam.workloadIdentityUser",
      member: Output.interpolate`principalSet://iam.googleapis.com/${pool.name}/attribute.repository/${OWNER}/${REPOSITORY}`,
    });

    yield* GCP.IAM.Member("DeployerReadsProject", {
      kind: "project",
      name: PROJECT,
      role: projectReader.name,
      member: deployerMember,
    });

    yield* GCP.IAM.Member("DeployerManagesVm", {
      kind: "compute.instance",
      name: VM,
      role: "roles/compute.instanceAdmin.v1",
      member: deployerMember,
    });

    yield* GCP.IAM.Member("DeployerLogsInToVm", {
      kind: "compute.instance",
      name: VM,
      role: "roles/compute.osAdminLogin",
      member: deployerMember,
    });

    yield* GCP.IAM.Member("DeployerActsAsVm", {
      kind: "iam.serviceAccount",
      name: `projects/${PROJECT}/serviceAccounts/${VM_SERVICE_ACCOUNT}`,
      role: "roles/iam.serviceAccountUser",
      member: deployerMember,
    });

    yield* GCP.IAM.Member("DeployerManagesRecordingsBucket", {
      kind: "storage.bucket",
      name: RECORDINGS_BUCKET,
      role: "roles/storage.admin",
      member: deployerMember,
    });

    yield* GitHub.Secret("WorkloadIdentityProviderSecret", {
      owner: OWNER,
      repository: REPOSITORY,
      name: "GCP_WORKLOAD_IDENTITY_PROVIDER",
      value: Output.map(oidc.name, Redacted.make),
    });

    yield* GitHub.Secret("ServiceAccountSecret", {
      owner: OWNER,
      repository: REPOSITORY,
      name: "GCP_SERVICE_ACCOUNT",
      value: Output.map(deployer.email, Redacted.make),
    });

    return { deployer: deployer.email, workloadIdentityProvider: oidc.name };
  }),
);
