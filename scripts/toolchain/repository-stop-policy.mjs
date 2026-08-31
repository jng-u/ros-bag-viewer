const infrastructureFiles = new Set(["pulumi.yaml", "serverless.yml", "serverless.yaml", "terraform.tfstate"]);

function contentText(content) {
  if (content === undefined) return "";
  return typeof content === "string" ? content : Buffer.from(content).toString("utf8");
}

export function repositoryStopReason(filename, content) {
  const normalized = filename.replaceAll("\\", "/").toLowerCase();
  const name = normalized.split("/").at(-1);
  const text = contentText(content);
  if (/^licen[cs]e(?:$|[-_.])/u.test(name)) return "public-license";
  if (/^(?:copying|notice)(?:$|[-_.])/u.test(name)) return "public-license";
  if (/^\.env(?:$|\.)/u.test(name)) return "credentials";
  if (/^(?:credentials?|secrets?|service-account|client[-_]?secret)(?:$|[-_.])/u.test(name) ||
      /^id_[a-z0-9][a-z0-9._-]*$/u.test(name) ||
      [".npmrc", ".netrc", ".pypirc", ".git-credentials", "application_default_credentials.json", "kubeconfig"].includes(name) ||
      normalized === ".kube/config" || normalized.endsWith("/.kube/config") ||
      /^kube[-_]?config(?:$|[-_.])/u.test(name) || /(?:^|[-_.])kubeconfig(?:$|[-_.])/u.test(name) ||
      /(?:^|[-_.])private[-_]?key(?:$|[-_.])/u.test(name) ||
      (normalized === ".docker/config.json" || normalized.endsWith("/.docker/config.json")) ||
      /^private(?:[-_.].*)?\.pem$/u.test(name) ||
      /\.(?:key|p12|pfx|jks|keystore)$/u.test(name)) return "credentials";
  if (/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u.test(text) ||
      text.includes("-----BEGIN PGP " + "PRIVATE KEY BLOCK-----") ||
      /["']type["']\s*:\s*["']service_account["']/u.test(text) && /["']private_key["']\s*:/u.test(text) ||
      /(?:^|\n)\s*(?:_auth|_authToken|\/\/.+?:_authToken)\s*=/u.test(text) ||
      /(?:^|\n)\s*clusters\s*:/u.test(text) && /(?:^|\n)\s*contexts\s*:/u.test(text) &&
        /(?:^|\n)\s*users\s*:/u.test(text) && /(?:^|\n)\s*current-context\s*:/u.test(text) &&
        /(?:token|client-key-data|client-certificate-data|password)\s*:/u.test(text)) return "credentials";
  if (
    infrastructureFiles.has(name) || name.endsWith(".tf") || name.endsWith(".tf.json") ||
    /\.(?:auto\.)?tfvars(?:\.json)?$/u.test(name) || /^terraform\.tfstate(?:\.|$)/u.test(name) ||
    [".terraformrc", "terraform.rc", ".terraform.lock.hcl", "terragrunt.hcl"].includes(name) ||
    /^pulumi(?:[._-].*)?\.(?:ya?ml|json)$/u.test(name) || normalized.split("/").includes(".pulumi") ||
    /^serverless(?:[._-].*)?\.(?:ya?ml|json|[cm]?[jt]s)$/u.test(name) || normalized.split("/").includes(".serverless") ||
    /^(?:dockerfile|containerfile)(?:$|[._-])/u.test(name) || /^(?:docker-)?compose(?:[._-].*)?\.ya?ml$/u.test(name) ||
    /^(?:cloudformation|cfn)(?:$|[._-])/u.test(name) || /^samconfig(?:[._-].*)?\.toml$/u.test(name) ||
    /^(?:sam-template|packaged|stack|template)(?:[._-].*)?\.(?:ya?ml|json)$/u.test(name) ||
    normalized.split("/").includes(".aws-sam") ||
    ["cdk.json", "cdk.context.json"].includes(name) || /^cdk[._-].*\.(?:json|[cm]?[jt]s)$/u.test(name) ||
    normalized.split("/").includes("cdk.out") ||
    /\.(?:ya?ml|json)$/u.test(name) &&
      /(?:AWSTemplateFormatVersion|AWS::Serverless-2016-10-31)/u.test(text) ||
    /\.ya?ml$/u.test(name) && /(?:^|\n)\s*Resources\s*:/u.test(text) &&
      /(?:^|\n)\s*Type\s*:\s*AWS::[A-Za-z0-9:]+/u.test(text) ||
    /\.json$/u.test(name) && /["']Resources["']\s*:/u.test(text) &&
      /["']Type["']\s*:\s*["']AWS::[A-Za-z0-9:]+["']/u.test(text) ||
    /\.(?:[cm]?[jt]sx?)$/u.test(name) && /(?:from\s*["']aws-cdk-lib["']|require\(\s*["']aws-cdk-lib["']\s*\))/u.test(text) ||
    name === "package.json" && /(?:"aws-cdk-lib"|"@aws-cdk\/|"npm:(?:aws-cdk-lib|@aws-cdk\/)|\bcdk\b[^"\n]*\bdeploy\b)/u.test(text)
  ) return "infrastructure";
  return undefined;
}
