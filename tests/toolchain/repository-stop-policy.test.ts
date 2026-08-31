import { describe, expect, it } from "vitest";
// @ts-expect-error The repository stop policy is an executable ESM tool without a declaration facade.
import { repositoryStopReason } from "../../scripts/toolchain/repository-stop-policy.mjs";

const infrastructureFiles = [
  "helm/values-prod.yml",
  "helm/Chart.lock",
  "infra/main.hcl",
  "release.tar.xz",
  "release.xz",
  "release.zst",
  "bundle.jar",
  "archive/release.zip",
  "deployment/output.txt",
  "helm/Chart.yaml",
  "helm/values.yaml",
  "Chart.yaml",
  "charts/viewer/Chart.yaml",
  "values.yaml",
  "charts/viewer/values.yaml",
  "release.tar.br",
  "bundle.war",
  "package.whl",
  "viewer.deb",
] as const;

const credentialFiles = [
  "prod.credentials.yaml",
  "auth-token.txt",
  "access-token.json",
  "npm-token.txt",
  "github_token.txt",
  "refresh-token.json",
  "session_token.yaml",
  "bearer.txt",
  "id-token.json",
  "oauth.json",
  "service_account.json",
] as const;

const infrastructureContents = [
  ["src/side-effect.ts", "import \"aws-" + "cdk-lib\";"],
  ["src/concatenated.ts", "require(\"aws-\" + \"cdk-lib\")"],
  ["src/template.ts", "await import(`@pulumi/" + "aws`)"],
  ["src/constant.ts", "const target = \"@pulumi/" + "aws\"; await import(target)"],
  ["src/reassigned.ts", "let target = \"safe-package\"; target = \"@pulumi/" + "aws\"; await import(target)"],
  ["src/compound.ts", "let target = \"@pulumi/\"; target += \"aws\"; await import(target)"],
  ["infra/aliased.py", "import importlib as loader\nloader.import_module(\"aws_" + "cdk.aws_s3\")"],
  ["infra/concatenated.py", "__import__(\"aws_\" + \"cdk\")"],
  ["infra/constant.py", "target = \"pulumi_" + "aws\"\n__import__(target)"],
  ["deployment.yaml", "kind: Deployment\napiVersion: apps/v1\nmetadata:\n  name: viewer"],
  ["resources.yaml", "items:\n  - apiVersion: v1\n    kind: ConfigMap\n    metadata:\n      name: viewer"],
  ["deployment.json", "{\"items\":[{\"kind\":\"CustomResourceDefinition\",\"apiVersion\":\"apiextensions.k8s.io/v1\"}]}"],
] as const;

const credentialContents = [
  ["config.ini", "github_" + "token=super-secret-token-value"],
  ["config.yaml", "PRIVATE_" + "KEY: super-secret-material"],
  ["config.yaml", String.raw`"private\u005fkey": super-secret-material`],
  ["tokens.yaml", "id_" + "token: super-secret-token-value"],
  ["tokens.yaml", "session_" + "token: super-secret-token-value"],
  ["tokens.yaml", "npm_" + "token: super-secret-token-value"],
  ["tokens.yaml", "secret_" + "token: super-secret-token-value"],
] as const;

const allowed = [
  ["LICENSES.md", ""],
  ["environment.md", ""],
  [".env-example", ""],
  ["src/module-name.ts", "const documented = \"aws-" + "cdk-lib\"; void documented"],
  ["src/safe-import.ts", "import \"aws-cdk-lite\""],
  ["src/reassigned-safe.ts", "let target = \"@pulumi/" + "aws\"; target = \"safe-package\"; await import(target)"],
  ["tools/safe.py", "target = \"pulumi_aws\"\nprint(target)"],
  ["helm/values-reference.md", ""],
  ["config/values.yaml", "image: viewer"],
  ["infra/main.hcl.txt", ""],
  ["release.xz.md", ""],
  ["github_tokenizer.txt", ""],
  ["config.yaml", "token_hint: documentation-only"],
  ["config.ini", "github_tokenizer=not-a-secret"],
  ["notes.yaml", "private_key_algorithm: rsa"],
  ["oauth-guide.md", ""],
  ["session-notes.md", ""],
  ["refresh-button.ts", ""],
  ["config.yaml", "apiVersion: 1"],
  ["notes.yml", "kind: note"],
  ["split.yaml", "metadata:\n  apiVersion: v1\nspec:\n  kind: note"],
  ["separate.yaml", "apiVersion: v1\n---\nkind: note"],
  ["separate-items.yaml", "items:\n  - apiVersion: v1\n  - kind: note"],
  ["split.json", "{\"metadata\":{\"apiVersion\":\"v1\"},\"spec\":{\"kind\":\"note\"}}"],
] as const;

describe("structured repository stop policy", () => {
  it.each(infrastructureFiles)("rejects infrastructure filename %s", (filename) => {
    expect(repositoryStopReason(filename)).toBe("infrastructure");
  });

  it.each(credentialFiles)("rejects credential filename %s", (filename) => {
    expect(repositoryStopReason(filename)).toBe("credentials");
  });

  it.each(infrastructureContents)("rejects structured infrastructure content in %s", (filename, content) => {
    expect(repositoryStopReason(filename, content)).toBe("infrastructure");
  });

  it.each(credentialContents)("rejects normalized credential content in %s", (filename, content) => {
    expect(repositoryStopReason(filename, content)).toBe("credentials");
  });

  it.each(allowed)("does not reject near-miss %s", (filename, content) => {
    expect(repositoryStopReason(filename, content)).toBeUndefined();
  });
});
