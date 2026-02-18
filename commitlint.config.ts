import type { UserConfig } from "@commitlint/types";
import { RuleConfigSeverity } from "@commitlint/types";

const configuration: UserConfig = {
  rules: {
    "body-leading-blank": [RuleConfigSeverity.Error, "always"],
    "body-max-line-length": [RuleConfigSeverity.Warning, "always", 74],
    "header-max-length": [RuleConfigSeverity.Error, "always", 50],
    "header-trim": [RuleConfigSeverity.Error, "always"],
    "subject-case": [RuleConfigSeverity.Error, "always", ["sentence-case"]],
    "subject-exclamation-mark": [RuleConfigSeverity.Error, "never"],
    "subject-full-stop": [RuleConfigSeverity.Error, "never", "."],
    "type-empty": [RuleConfigSeverity.Error, "always"],
  },
};

export default configuration;
