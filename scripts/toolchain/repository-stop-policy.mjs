const infrastructureFiles = new Set(["pulumi.yaml", "serverless.yml", "serverless.yaml", "terraform.tfstate"]);
const credentialDirectories = new Set([".aws", ".azure", ".config/gcloud", "credentials", "secrets"]);

function contentText(content) {
  if (content === undefined) return "";
  return typeof content === "string" ? content : Buffer.from(content).toString("utf8");
}

export function repositoryStopReason(filename, content) {
  const normalized = filename.replaceAll("\\", "/").toLowerCase();
  const name = normalized.split("/").at(-1);
  const segments = normalized.split("/");
  const text = contentText(content);
  if (/^licen[cs]e(?:$|[-_.])/u.test(name)) return "public-license";
  if (/^(?:copying|notice)(?:$|[-_.])/u.test(name)) return "public-license";
  if (name === "package.json" && /["']license["']\s*:\s*["'][^"']+["']/iu.test(text)) return "public-license";
  if (/^\.env(?:$|\.)/u.test(name)) return "credentials";
  if (/^(?:credentials?|secrets?|service-account|client[-_]?secret)(?:$|[-_.])/u.test(name) ||
      /^id_[a-z0-9][a-z0-9._-]*$/u.test(name) ||
      [".npmrc", ".netrc", ".pypirc", ".git-credentials", "application_default_credentials.json", "kubeconfig"].includes(name) ||
      normalized === ".aws/config" || normalized.endsWith("/.aws/config") ||
      credentialDirectories.has(segments.slice(0, -1).join("/")) || segments.some((segment) => credentialDirectories.has(segment)) ||
      normalized.includes("/.config/gcloud/") || normalized.startsWith(".config/gcloud/") ||
      normalized === ".kube/config" || normalized.endsWith("/.kube/config") ||
      /^kube[-_]?config(?:$|[-_.])/u.test(name) || /(?:^|[-_.])kubeconfig(?:$|[-_.])/u.test(name) ||
      /(?:^|[-_.])private[-_]?key(?:$|[-_.])/u.test(name) ||
      (normalized === ".docker/config.json" || normalized.endsWith("/.docker/config.json")) ||
      /^private(?:[-_.].*)?\.pem$/u.test(name) ||
      /^(?:google|gcp|azure)[-_.].*credentials?(?:$|[-_.])/u.test(name) ||
      /\.(?:key|p12|pfx|jks|keystore)$/u.test(name)) return "credentials";
  if (/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u.test(text) ||
      text.includes("-----BEGIN PGP " + "PRIVATE KEY BLOCK-----") ||
      /["']type["']\s*:\s*["']service_account["']/u.test(text) && /["']private_key["']\s*:/u.test(text) ||
      /["']private_key["']\s*:\s*["'][^"']{8,}["']/u.test(text) ||
      /(?:^|\n)\s*aws_(?:access_key_id|secret_access_key|session_token)\s*=\s*\S+/iu.test(text) ||
      /(?:^|\n)\s*(?:_auth|_authToken|\/\/.+?:_authToken)\s*=/u.test(text) ||
      /(?:^|\n)\s*clusters\s*:/u.test(text) && /(?:^|\n)\s*contexts\s*:/u.test(text) &&
        /(?:^|\n)\s*users\s*:/u.test(text) && /(?:^|\n)\s*current-context\s*:/u.test(text) &&
        /(?:token|client-key-data|client-certificate-data|password)\s*:/u.test(text) ||
      /(?:^|[,{\n]\s*)["']?(?:access[_-]?token|auth(?:orization)?[_-]?token|api[_-]?key|client[_-]?secret|refresh[_-]?token|password)["']?\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{8,}/iu.test(text) ||
      /(?:^|\n)\s*authorization\s*:\s*bearer\s+\S+/iu.test(text)) return "credentials";
  if (
    infrastructureFiles.has(name) || name.endsWith(".tf") || name.endsWith(".tf.json") ||
    name.endsWith(".bicep") ||
    segments[0] === "dist" || segments[0] === "artifacts" ||
    segments.some((segment) => ["deploy", "deployment"].includes(segment)) && /\.(?:zip|tar|tgz|gz|7z)$/u.test(name) ||
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
    segments.some((segment) => segment === ".terraform" || segment === ".terragrunt" || segment === ".cdktf") ||
    /^(?:deploy|deployment|cloudformation|terraform|cdktf)(?:[._-].*)?\.(?:json|ya?ml|[cm]?[jt]s)$/u.test(name) &&
      segments.some((segment) => ["dist", "build", "out", "artifacts", "deploy", "deployment"].includes(segment)) ||
    /\.(?:ya?ml|json)$/u.test(name) &&
      /(?:AWSTemplateFormatVersion|AWS::Serverless-2016-10-31)/u.test(text) ||
    /\.ya?ml$/u.test(name) && /(?:^|\n)\s*Type\s*:\s*AWS::[A-Za-z0-9:]+/u.test(text) ||
    /\.json$/u.test(name) && /["']Type["']\s*:\s*["']AWS::[A-Za-z0-9:]+["']/u.test(text) ||
    /\.ya?ml$/u.test(name) && /(?:^|\n)\s*apiVersion\s*:\s*[^\n]+\n(?:.|\n)*?\s*kind\s*:\s*(?:Deployment|StatefulSet|DaemonSet|Service|Ingress|Secret)\b/u.test(text) ||
    /\.(?:[cm]?[jt]sx?)$/u.test(name) && /(?:from\s*["'](?:aws-cdk-lib|@aws-cdk\/[^"']+|cdktf)(?:\/[^"']*)?["']|require\(\s*["'](?:aws-cdk-lib|@aws-cdk\/[^"']+|cdktf)(?:\/[^"']*)?["']\s*\)|import\(\s*["'](?:aws-cdk-lib|@aws-cdk\/[^"']+|cdktf)(?:\/[^"']*)?["']\s*\))/u.test(text) ||
    /\.py$/u.test(name) && /(?:^|\n)\s*(?:from|import)\s+aws_cdk\b/u.test(text) ||
    name === "package.json" && /(?:"aws-cdk-lib"|"@aws-cdk\/|"cdktf"|"@pulumi\/aws"|"pulumi"|"serverless"|"npm:(?:aws-cdk-lib|@aws-cdk\/|cdktf)|\bcdk\b[^"\n]*\bdeploy\b)/u.test(text)
  ) return "infrastructure";
  return undefined;
}
