export default class DeterministicVitestReporter {
  assertions = [];

  onTestCaseResult(testCase) {
    const result = testCase.result();
    if (result.state === "skipped") return;
    this.assertions.push(Object.freeze({
      file: testCase.module.relativeModuleId.replaceAll("\\", "/"),
      testName: testCase.fullName.replaceAll(" > ", " "),
      status: result.state,
    }));
  }

  onTestRunEnd(_modules, errors, reason) {
    const report = {
      schemaVersion: 1,
      reason,
      unhandledErrors: errors.length,
      assertions: this.assertions,
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
}
