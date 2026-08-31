const infrastructureFiles = new Set(["pulumi.yaml", "serverless.yml", "serverless.yaml", "terraform.tfstate"]);

export function repositoryStopReason(filename) {
  const name = filename.toLowerCase();
  if (/^licen[cs]e(?:$|[-_.])/u.test(name)) return "public-license";
  if (/^\.env(?:$|\.)/u.test(name)) return "credentials";
  if (infrastructureFiles.has(name) || name.endsWith(".tf")) return "infrastructure";
  return undefined;
}
