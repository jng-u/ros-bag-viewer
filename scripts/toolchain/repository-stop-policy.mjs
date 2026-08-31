const infrastructureFiles = new Set(["pulumi.yaml", "serverless.yml", "serverless.yaml", "terraform.tfstate"]);

export function repositoryStopReason(filename) {
  const name = filename.replaceAll("\\", "/").split("/").at(-1).toLowerCase();
  if (/^licen[cs]e(?:$|[-_.])/u.test(name)) return "public-license";
  if (/^(?:copying|notice)(?:$|[-_.])/u.test(name)) return "public-license";
  if (/^\.env(?:$|\.)/u.test(name)) return "credentials";
  if (/^(?:credentials?|secrets?|service-account)(?:$|[-_.])/u.test(name) ||
      /^id_(?:rsa|dsa|ecdsa|ed25519)(?:$|[-_.])/u.test(name) ||
      [".npmrc", ".netrc"].includes(name) || /\.(?:key|pem)$/u.test(name)) return "credentials";
  if (infrastructureFiles.has(name) || name.endsWith(".tf")) return "infrastructure";
  return undefined;
}
