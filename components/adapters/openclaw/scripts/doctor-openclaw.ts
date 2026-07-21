#!/usr/bin/env node
import { formatOpenClawDoctorReport, inspectOpenClawDoctor } from "../src/commands/tokenpilot/openclaw-doctor.js";

const report = inspectOpenClawDoctor();
console.log(formatOpenClawDoctorReport(report));

if (!report.ok) {
  process.exitCode = 1;
}
