const [lane = "unknown", milestone = "later"] = process.argv.slice(2);

console.log(
  `${lane}: SKIP — runtime evidence is intentionally deferred to ${milestone}; M0 validates only the repository, contracts, corpus metadata, and desktop UX evidence contract.`,
);
