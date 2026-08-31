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
  "viewer.rpm",
  "viewer.apk",
  "viewer.cab",
  "viewer.dmg",
  "viewer.iso",
  "viewer.crate",
  "viewer.tar.lz4",
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
  ["src/conditional.ts", "let target = \"@pulumi/" + "aws\"; if (enabled) target = \"safe-package\"; await import(target)"],
  ["src/conditional-hostile.ts", "let target = \"safe-package\"; if (enabled) target = \"@pulumi/" + "aws\"; await import(target)"],
  ["src/import-alias.ts", "const load = (name: string) => import(name); load(\"@pulumi/" + "aws\")"],
  ["src/require-alias.ts", "const load = require; load(\"aws-" + "cdk-lib\")"],
  ["src/conditional-loader.ts", "let load = require; if (enabled) load = (name: string) => import(\"safe-package\"); load(\"@pulumi/aws\")"],
  ["src/scoped-loader.ts", "const load = require; { const load = (name: string) => import(\"safe-package\"); } load(\"@pulumi/aws\")"],
  ["src/loader-chain.ts", "const base = require; const load = base; load(\"aws-cdk-lib\")"],
  ["src/wrapper-chain.ts", "const base = require; const load = (name: string) => base(name); load(\"aws-cdk-lib\")"],
  ["src/function-wrapper.ts", "function load(name: string) { return require(name); } load(\"aws-cdk-lib\")"],
  ["infra/aliased.py", "import importlib as loader\nloader.import_module(\"aws_" + "cdk.aws_s3\")"],
  ["infra/concatenated.py", "__import__(\"aws_\" + \"cdk\")"],
  ["infra/constant.py", "target = \"pulumi_" + "aws\"\n__import__(target)"],
  ["infra/conditional.py", "target = \"pulumi_" + "aws\"\nif enabled:\n  target = \"safe_package\"\n__import__(target)"],
  ["infra/conditional-hostile.py", "target = \"safe_package\"\nif enabled:\n  target = \"pulumi_" + "aws\"\n__import__(target)"],
  ["infra/loader-alias.py", "import importlib\nload = importlib.import_module\nload(\"aws_" + "cdk.aws_s3\")"],
  ["infra/conditional-loader.py", "load = __import__\nif enabled:\n  load = print\nload(\"pulumi_aws\")"],
  ["infra/function-shadow.py", "load = __import__\ndef configure(value):\n  load = print\nload(\"pulumi_aws\")"],
  ["infra/loader-chain.py", "import importlib\nbase = importlib.import_module\nload = base\nload(\"aws_cdk.aws_s3\")"],
  ["infra/lambda-wrapper.py", "import importlib\nload = lambda name: importlib.import_module(name)\nload(\"pulumi_aws\")"],
  ["infra/function-wrapper.py", "import importlib\ndef load(name):\n  return importlib.import_module(name)\nload(\"pulumi_aws\")"],
  ["deployment.yaml", "kind: Deployment\napiVersion: apps/v1\nmetadata:\n  name: viewer"],
  ["resources.yaml", "items:\n  - apiVersion: v1\n    kind: ConfigMap\n    metadata:\n      name: viewer"],
  ["quoted.yaml", "\"apiVersion\": v1\n'kind': ConfigMap"],
  ["flow.yaml", "resource: { apiVersion: v1, kind: ConfigMap, metadata: { name: viewer } }"],
  ["nested-flow.yaml", "resources: [{ metadata: { name: viewer }, spec: { template: {} }, apiVersion: apps/v1, kind: Deployment }]"],
  ["deep-flow.yaml", "root: { items: [{ resource: { 'apiVersion': v1, \"kind\": ConfigMap } }] }"],
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
  ["src/github.ts", "const githubToken = \"" + "ghp_" + "A".repeat(36) + "\""],
  ["src/token.ts", "const token = \"Abc123TokenSecretValue987\""],
  ["tools/token.py", "token = \"Abc123TokenSecretValue987\""],
] as const;

const allowed = [
  ["LICENSES.md", ""],
  ["environment.md", ""],
  [".env-example", ""],
  ["src/module-name.ts", "const documented = \"aws-" + "cdk-lib\"; void documented"],
  ["src/safe-import.ts", "import \"aws-cdk-lite\""],
  ["src/reassigned-safe.ts", "let target = \"@pulumi/" + "aws\"; target = \"safe-package\"; await import(target)"],
  ["src/scoped-loader-safe.ts", "const load = (name: string) => import(\"safe-package\"); { const load = require; load(\"safe-package\"); } load(\"@pulumi/aws\")"],
  ["src/conditional-loader-safe.ts", "let load = require; if (enabled) load = (name: string) => import(\"safe-package\"); else load = (name: string) => import(\"safe-package\"); load(\"@pulumi/aws\")"],
  ["src/id_parser.ts", "export const parse = (value: string) => value"],
  ["src/token-placeholder.ts", "const token = \"replace-me\""],
  ["src/relay.test.ts", "const request = { credential: \"edge-only-secret\" }; void request"],
  ["tools/safe.py", "target = \"pulumi_aws\"\nprint(target)"],
  ["tools/scoped-loader-safe.py", "load = print\ndef configure(name):\n  load = __import__\n  load(\"safe_package\")\nload(\"pulumi_aws\")"],
  ["tools/conditional-loader-safe.py", "load = __import__\nif enabled:\n  load = print\nelse:\n  load = print\nload(\"pulumi_aws\")"],
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
  ["separate-flow-items.yaml", "items: [{ apiVersion: v1 }, { kind: ConfigMap }]"],
  ["separate-flow-containers.yaml", "root: { metadata: { apiVersion: v1 }, spec: { kind: Deployment } }"],
  ["split.json", "{\"metadata\":{\"apiVersion\":\"v1\"},\"spec\":{\"kind\":\"note\"}}"],
  ["lexer.json", "{\"token\":{\"kind\":\"identifier\",\"start\":0,\"end\":3}}"],
  ["schema.json", "{\"properties\":{\"token\":{\"type\":\"string\"}}}"],
  ["descriptor.json", "{\"token\":\"identifier\"}"],
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
