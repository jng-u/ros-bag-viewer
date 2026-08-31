const infrastructureFiles = new Set(["pulumi.yaml", "serverless.yml", "serverless.yaml", "terraform.tfstate"]);

export function repositoryStopReason(filename) {
  const normalized = filename.replaceAll("\\", "/").toLowerCase();
  const name = normalized.split("/").at(-1);
  if (/^licen[cs]e(?:$|[-_.])/u.test(name)) return "public-license";
  if (/^(?:copying|notice)(?:$|[-_.])/u.test(name)) return "public-license";
  if (/^\.env(?:$|\.)/u.test(name)) return "credentials";
  if (/^(?:credentials?|secrets?|service-account)(?:$|[-_.])/u.test(name) ||
      /^id_(?:rsa|dsa|ecdsa|ed25519)(?:$|[-_.])/u.test(name) ||
      [".npmrc", ".netrc"].includes(name) || /\.(?:key|pem)$/u.test(name)) return "credentials";
  if (
    infrastructureFiles.has(name) || name.endsWith(".tf") || name.endsWith(".tf.json") ||
    /\.(?:auto\.)?tfvars(?:\.json)?$/u.test(name) || /^terraform\.tfstate(?:\.|$)/u.test(name) ||
    [".terraformrc", "terraform.rc", ".terraform.lock.hcl", "terragrunt.hcl"].includes(name) ||
    /^pulumi(?:[._-].*)?\.(?:ya?ml|json)$/u.test(name) || normalized.split("/").includes(".pulumi") ||
    /^serverless(?:[._-].*)?\.(?:ya?ml|json|[cm]?[jt]s)$/u.test(name) || normalized.split("/").includes(".serverless") ||
    /^(?:dockerfile|containerfile)(?:$|[._-])/u.test(name) || /^(?:docker-)?compose(?:[._-].*)?\.ya?ml$/u.test(name) ||
    /^(?:cloudformation|cfn)(?:$|[._-])/u.test(name) || name === "samconfig.toml" ||
    ["cdk.json", "cdk.context.json"].includes(name) || normalized.split("/").includes("cdk.out")
  ) return "infrastructure";
  return undefined;
}
