const UI_SPEC = `// @playwright-project ui
import { test } from "@playwright/test";
test.skip(true, "synthetic topology fixture");
test("synthetic-ui", async ({ page }) => void page);
`;
const NODE_DB_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { writeFileSync } from "node:fs";
test("synthetic-node-db", async () => {
  const marker = process.env.SYNTHETIC_TOPOLOGY_EXECUTION_MARKER;
  if (marker) writeFileSync(marker, "executed", "utf8");
});
`;
const NODE_DB_PROJECT_SKIP_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
test("node-db", async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "run once");
});
`;
const UI_ALIAS_SPEC = `// @playwright-project ui
import { test as it } from "@playwright/test";
it("ui alias", async ({ page }) => void page);
`;
const ESCAPED_FIXTURE_UI_SPEC = `// @playwright-project ui
import { test } from "@playwright/test";
test("escaped fixture", async ({ p\\u0061ge }) => void page);
`;
const COMPUTED_FIXTURE_KEY_SPEC = `// @playwright-project ui
import { test } from "@playwright/test";
test("computed fixture", async ({ ["page"]: page }) => void page);
`;
const SUPPORTED_PLAYWRIGHT_API_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
test.describe.fixme("fixme suite", () => {
  test("fixme test", async () => undefined);
});
test.describe.serial.only("serial suite", () => {
  test("serial test", async () => undefined);
});
test.describe.parallel.only("parallel suite", () => {
  test("parallel test", async () => undefined);
});
test("reads TestInfo", async () => {
  const projectName = test.info().project.name;
  const testInfo = test.info();
  await test.info().attach("synthetic", {
    body: "topology",
    contentType: "text/plain",
  });
  void projectName;
  void testInfo.title;
});
test("uses TestType expect paths", async () => {
  test.expect.soft(1).toBe(1);
  await test.expect.poll(() => 1).toBe(1);
  test.expect.configure({ soft: true })(1).toBe(1);
  test.expect.extend({
    toBeOne(received) {
      return { pass: received === 1, message: () => "expected one" };
    },
  })(1).toBeOne();
  void test.expect.getState();
  test.expect(test.expect.any(Number)).toBeTruthy();
  test.expect(test.expect.not.stringContaining("hidden")).toBeTruthy();
});
`;
const SUITE_MAP_CONSTRUCTOR_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
test.describe("suite", () => {
  const originalEnv = new Map<string, string | undefined>();
  test.beforeEach(() => {
    originalEnv.set("NAME", process.env.NAME);
  });
  test("uses map", async () => undefined);
});
`;
const ISOLATED_GLOBAL_SHADOW_SPEC = `// @playwright-project node-db
import { readFileSync } from "node:fs";
import { test } from "@playwright/test";
test.skip(Boolean(false), "static condition");
new Map();
Array.isArray([]);
readFileSync("fixture");
function nested(Array, Boolean, Map, readFileSync) {
  void Array;
  void Boolean;
  void Map;
  void readFileSync;
}
test("official", async () => undefined);
`;
const OFFICIAL_TEST_SHADOW_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
test("official", async () => {
  const echo = (test: string) => test;
  const invoke = (test: () => number) => test();
  function increment(test: number) {
    return test + 1;
  }
  void echo("ok");
  void invoke(() => 1);
  void increment(1);
});
`;
function conditionalAnnotationSpec(annotationMethod: string): string {
  return `// @playwright-project node-db
import { test } from "@playwright/test";
test.${annotationMethod}(({ page }) => Boolean(page), "browser condition");
test("official node test", async () => undefined);
`;
}
function indirectConditionalAnnotationSpec(annotationMethod: string): string {
  return `// @playwright-project node-db
import { test } from "@playwright/test";
const condition = ({ page }) => Boolean(page);
test.${annotationMethod}(condition, "browser condition");
test("official node test", async () => undefined);
`;
}
function wrappedConditionalAnnotationSpec(annotationMethod: string): string {
  return `// @playwright-project node-db
import { test } from "@playwright/test";
test.${annotationMethod}((((({ page }) => Boolean(page))) as ({ page }: { page: unknown }) => boolean), "browser condition");
test("official node test", async () => undefined);
`;
}
const CUSTOM_FIXTURE_SPEC = `// @playwright-project ui
import { test as custom } from "./fixtures";
custom("custom", async ({ page }) => void page);
`;
const RENAMED_CUSTOM_FIXTURE_SPEC = `// @playwright-project ui
import { test } from "@playwright/test";
import { custom } from "./fixtures";
custom("custom", async ({ page }) => void page);
test("official", async ({ page }) => void page);
`;
const INDIRECT_CALLBACK_SPEC = `// @playwright-project ui
import { test } from "@playwright/test";
const callback = async ({ page }: { page: unknown }) => void page;
test("indirect callback", callback);
`;
const LOCAL_ALIAS_SPEC = `// @playwright-project ui
import { test } from "@playwright/test";
const it = test;
it("local alias", async ({ page }) => void page);
`;
const COMPUTED_ALIAS_SPEC = `// @playwright-project ui
import { test } from "@playwright/test";
const it = test["only"];
it("computed alias", async ({ page }) => void page);
`;
const BOUND_ALIAS_SPEC = `// @playwright-project ui
import { test } from "@playwright/test";
const it = test.bind(undefined);
it("bound alias", async ({ page }) => void page);
`;
const CONTAINER_ALIAS_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
const box = { it: test };
box.it("container alias", async ({ page }) => void page);
`;
const FACTORY_ALIAS_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
const it = (() => test)();
it("factory alias", async ({ page }) => void page);
`;
const PARAMETER_ALIAS_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
function register(it) {
  it("parameter alias", async ({ page }) => void page);
}
register(test);
`;
const DEFAULT_PARAMETER_ALIAS_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
function register(it = test) {
  it("default parameter alias", async ({ page }) => void page);
}
register();
`;
const CALL_RETURN_ALIAS_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
function currentTest() {
  return test;
}
const it = currentTest();
it("call return alias", async ({ page }) => void page);
`;
const REGISTRATION_HELPER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
function register() {
  custom("custom", async ({ page }) => void page);
}
register();
test("official", async () => undefined);
`;
const DESCRIBE_REGISTRATION_HELPER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
function register() {
  custom("custom", async ({ page }) => void page);
}
test.describe("suite", () => {
  register();
});
test("official", async () => undefined);
`;
const SAFE_GLOBAL_REGISTRATION_HELPER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
function register() {
  custom("custom", async ({ page }) => void page);
  return 0;
}
Array.from([0], register);
test("official", async () => undefined);
`;
const PROMISE_REGISTRATION_HELPER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
function register(resolve) {
  custom("custom", async ({ page }) => void page);
  resolve();
}
new Promise(register);
test("official", async () => undefined);
`;
const CONSTRUCTOR_REGISTRATION_HELPER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
class Register {
  constructor() {
    custom("custom", async ({ page }) => void page);
  }
}
new Register();
test("official", async () => undefined);
`;
const SHADOWED_FUNCTION_GLOBAL_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
function Array() {
  custom("custom", async ({ page }) => void page);
}
Array();
test("official", async () => undefined);
`;
const SHADOWED_ALIAS_GLOBAL_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
function register() {
  custom("custom", async ({ page }) => void page);
}
const Array = register;
Array();
test("official", async () => undefined);
`;
const SHADOWED_CONSTRUCTOR_GLOBAL_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
class Array {
  constructor() {
    custom("custom", async ({ page }) => void page);
  }
}
new Array();
test("official", async () => undefined);
`;
const SHADOWED_NODE_BUILTIN_FUNCTION_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { custom } from "./fixtures";
test.describe("suite", () => {
  function readFileSync() {
    custom("custom", async ({ page }) => void page);
  }
  readFileSync();
});
test("official", async () => undefined);
`;
const SHADOWED_NODE_BUILTIN_ALIAS_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { custom } from "./fixtures";
function register() {
  custom("custom", async ({ page }) => void page);
}
test.describe("suite", () => {
  const readFileSync = register;
  readFileSync();
});
test("official", async () => undefined);
`;
const NODE_BUILTIN_FACTORY_HELPER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { promisify } from "node:util";
import { custom } from "./fixtures";
function register(callback) {
  custom("custom", async ({ page }) => void page);
  callback(null);
}
promisify(register)();
test("official", async () => undefined);
`;
const WRAPPED_NODE_BUILTIN_CALLBACK_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { promisify } from "node:util";
import { custom } from "./fixtures";
promisify((((callback) => {
  custom("custom", async ({ page }) => void page);
  callback(null);
}) as (callback: (error: null) => void) => void))();
test("official", async () => undefined);
`;
const CONDITIONAL_NODE_BUILTIN_FACTORY_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { promisify } from "node:util";
import { custom } from "./fixtures";
function register(callback) {
  custom("custom", async ({ page }) => void page);
  callback(null);
}
promisify(true ? register : register)();
test("official", async () => undefined);
`;
const CONDITIONAL_NODE_BUILTIN_CALLBACK_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
function register() {
  custom("custom", async ({ page }) => void page);
}
doesNotThrow(true ? register : register);
test("official", async () => undefined);
`;
const DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const box = {
  register() {
    custom("hidden browser test", async ({ page }) => void page);
  },
};
const { register } = box;
doesNotThrow(register);
test("official", async () => undefined);
`;
const SPREAD_DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const base = {
  register() {
    custom("hidden browser test", async ({ page }) => void page);
  },
};
const box = { ...base };
const { register } = box;
doesNotThrow(register);
test("official", async () => undefined);
`;
const COMPUTED_DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const key = "register";
const box = {
  [key]() {
    custom("hidden browser test", async ({ page }) => void page);
  },
};
const { register } = box;
doesNotThrow(register);
test("official", async () => undefined);
`;
const ASSIGNED_DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const box = {};
box.register = () =>
  custom("hidden browser test", async ({ page }) => void page);
const { register } = box;
doesNotThrow(register);
test("official", async () => undefined);
`;
const REASSIGNED_DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const box = { register: 0 };
box.register = () =>
  custom("hidden browser test", async ({ page }) => void page);
const { register } = box;
doesNotThrow(register);
test("official", async () => undefined);
`;
const PROPERTY_ALIAS_NODE_BUILTIN_CALLBACK_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const box = {
  register() {
    custom("hidden browser test", async ({ page }) => void page);
  },
};
const register = box.register;
doesNotThrow(register);
test("official", async () => undefined);
`;
const SHADOWED_PROCESS_ENV_CALLBACK_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const process = {
  env: {
    register() {
      custom("hidden browser test", async ({ page }) => void page);
    },
  },
};
const register = process.env.register;
doesNotThrow(register);
test("official", async () => undefined);
`;
const PROCESS_ENV_PROTOTYPE_CALLBACK_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
String.prototype.trim = function register() {
  custom("hidden browser test", async ({ page }) => void page);
  return "";
};
const register = process.env.FLAG?.trim;
doesNotThrow(register);
test("official", async () => undefined);
`;
const PROCESS_ENV_CONDITIONAL_CALLBACK_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const register = process.env.FLAG
  ? () => custom("hidden browser test", async ({ page }) => void page)
  : undefined;
doesNotThrow(register);
test("official", async () => undefined);
`;
const REPLACED_PROCESS_ENV_CALLBACK_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
process.env = {
  FLAG: (() =>
    custom("hidden browser test", async ({ page }) => void page)) as unknown as string,
};
doesNotThrow(process.env.FLAG as unknown as () => void);
test("official", async () => undefined);
`;
const REPLACED_GLOBAL_PROCESS_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
globalThis.process = {
  env: {
    FLAG: (() =>
      custom("hidden browser test", async ({ page }) => void page)) as unknown as string,
  },
} as unknown as NodeJS.Process;
doesNotThrow(process.env.FLAG as unknown as () => void);
test("official", async () => undefined);
`;
const REPLACED_GLOBAL_COMPUTED_PROCESS_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const root = global;
root["process"] = {
  env: {
    FLAG: (() =>
      custom("hidden browser test", async ({ page }) => void page)) as unknown as string,
  },
} as unknown as NodeJS.Process;
doesNotThrow(process.env.FLAG as unknown as () => void);
test("official", async () => undefined);
`;
const REPLACED_GLOBAL_CONSTANT_KEY_PROCESS_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const key = "process" as const;
globalThis[key] = {
  env: {
    FLAG: (() =>
      custom("hidden browser test", async ({ page }) => void page)) as unknown as string,
  },
} as unknown as NodeJS.Process;
doesNotThrow(process.env.FLAG as unknown as () => void);
test("official", async () => undefined);
`;
const SHADOWED_BOOLEAN_CONDITION_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
function Boolean() {
  return true;
}
test.skip(Boolean(false), "shadowed condition");
test("official", async () => undefined);
`;
const REGISTRATION_GETTER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const box = {
  get run() {
    custom("custom", async ({ page }) => void page);
    return true;
  },
};
void box.run;
test("official", async () => undefined);
`;
const NESTED_REGISTRATION_GETTER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const box = {
  nested: {
    get run() {
      custom("custom", async ({ page }) => void page);
      return true;
    },
  },
};
void box.nested.run;
test("official", async () => undefined);
`;
const INLINE_REGISTRATION_GETTER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
void ({
  get run() {
    custom("custom", async ({ page }) => void page);
    return true;
  },
}).run;
test("official", async () => undefined);
`;
const IMPORTED_REGISTRATION_GETTER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { box } from "./getter-fixture";
void box.run;
test("official", async () => undefined);
`;
const DEFINE_PROPERTY_REGISTRATION_GETTER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const box = {};
Object.defineProperty(box, "run", {
  get() {
    custom("custom", async ({ page }) => void page);
    return true;
  },
});
void box.run;
test("official", async () => undefined);
`;
const DESTRUCTURED_REGISTRATION_GETTER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const box = {
  get run() {
    custom("custom", async ({ page }) => void page);
    return true;
  },
};
const { run } = box;
void run;
test("official", async () => undefined);
`;
const SPREAD_REGISTRATION_GETTER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const box = {
  get run() {
    custom("custom", async ({ page }) => void page);
    return true;
  },
};
const copy = { ...box };
void copy;
test("official", async () => undefined);
`;
const SPREAD_REGISTRATION_ITERATOR_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const iterable = {
  *[Symbol.iterator]() {
    custom("custom", async ({ page }) => void page);
  },
};
const copy = [...iterable];
void copy;
test("official", async () => undefined);
`;
const REGISTRATION_TAGGED_TEMPLATE_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
function register() {
  custom("custom", async ({ page }) => void page);
}
register\`custom\`;
test("official", async () => undefined);
`;
const STRING_RAW_TAG_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
const childProcessProbeSource = String.raw\`
  const guardCode = "guard";
\`;
void childProcessProbeSource;
test("official", async () => undefined);
`;
const SHADOWED_STRING_RAW_TAG_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
const String = { raw: (parts: TemplateStringsArray) => parts.raw.join("") };
const source = String.raw\`shadowed\`;
void source;
test("official", async () => undefined);
`;
const IMPORTED_STRING_RAW_TAG_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { String } from "./fixtures";
const source = String.raw\`imported\`;
void source;
test("official", async () => undefined);
`;
const NAMESPACE_FIXTURE_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import * as fixtures from "./fixtures";
const { custom } = fixtures;
custom("custom", async ({ page }) => void page);
test("official", async () => undefined);
`;
const INLINE_EXTEND_SPEC = `// @playwright-project ui
import { test } from "@playwright/test";
const custom = test.extend({ role: async ({}, use) => use("owner") });
custom("custom", async ({ page }) => void page);
`;
const OFFICIAL_TEST_WITH_HELPER_SPEC = `// @playwright-project ui
import { test } from "@playwright/test";
import { ordinaryHelper } from "./ordinary-helper";
test("official", async ({ page }) => {
  ordinaryHelper();
  void page;
});
`;
const PLAYWRIGHT_DEFAULT_UNSUPPORTED_FILENAMES = [
  "unsupported.test.ts",
  "unsupported.spec.tsx",
  "unsupported.test.tsx",
  "unsupported.spec.js",
  "unsupported.test.js",
  "unsupported.spec.jsx",
  "unsupported.test.jsx",
  "unsupported.spec.mjs",
  "unsupported.test.mjs",
  "unsupported.spec.mjsx",
  "unsupported.test.mjsx",
  "unsupported.spec.cjs",
  "unsupported.test.cjs",
  "unsupported.spec.cjsx",
  "unsupported.test.cjsx",
  "unsupported.spec.mts",
  "unsupported.test.mts",
  "unsupported.spec.mtsx",
  "unsupported.test.mtsx",
  "unsupported.spec.cts",
  "unsupported.test.cts",
  "unsupported.spec.ctsx",
  "unsupported.test.ctsx",
] as const;

export {
  ASSIGNED_DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC,
  BOUND_ALIAS_SPEC,
  CALL_RETURN_ALIAS_SPEC,
  COMPUTED_ALIAS_SPEC,
  COMPUTED_DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC,
  COMPUTED_FIXTURE_KEY_SPEC,
  CONDITIONAL_NODE_BUILTIN_CALLBACK_SPEC,
  CONDITIONAL_NODE_BUILTIN_FACTORY_SPEC,
  CONSTRUCTOR_REGISTRATION_HELPER_SPEC,
  CONTAINER_ALIAS_SPEC,
  CUSTOM_FIXTURE_SPEC,
  DEFAULT_PARAMETER_ALIAS_SPEC,
  DEFINE_PROPERTY_REGISTRATION_GETTER_SPEC,
  DESCRIBE_REGISTRATION_HELPER_SPEC,
  DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC,
  DESTRUCTURED_REGISTRATION_GETTER_SPEC,
  ESCAPED_FIXTURE_UI_SPEC,
  FACTORY_ALIAS_SPEC,
  IMPORTED_REGISTRATION_GETTER_SPEC,
  IMPORTED_STRING_RAW_TAG_SPEC,
  INDIRECT_CALLBACK_SPEC,
  INLINE_EXTEND_SPEC,
  INLINE_REGISTRATION_GETTER_SPEC,
  ISOLATED_GLOBAL_SHADOW_SPEC,
  LOCAL_ALIAS_SPEC,
  NAMESPACE_FIXTURE_SPEC,
  NESTED_REGISTRATION_GETTER_SPEC,
  NODE_BUILTIN_FACTORY_HELPER_SPEC,
  NODE_DB_PROJECT_SKIP_SPEC,
  NODE_DB_SPEC,
  OFFICIAL_TEST_SHADOW_SPEC,
  OFFICIAL_TEST_WITH_HELPER_SPEC,
  PARAMETER_ALIAS_SPEC,
  PLAYWRIGHT_DEFAULT_UNSUPPORTED_FILENAMES,
  PROCESS_ENV_CONDITIONAL_CALLBACK_SPEC,
  PROCESS_ENV_PROTOTYPE_CALLBACK_SPEC,
  PROMISE_REGISTRATION_HELPER_SPEC,
  PROPERTY_ALIAS_NODE_BUILTIN_CALLBACK_SPEC,
  REASSIGNED_DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC,
  REGISTRATION_GETTER_SPEC,
  REGISTRATION_HELPER_SPEC,
  REGISTRATION_TAGGED_TEMPLATE_SPEC,
  RENAMED_CUSTOM_FIXTURE_SPEC,
  REPLACED_GLOBAL_COMPUTED_PROCESS_SPEC,
  REPLACED_GLOBAL_CONSTANT_KEY_PROCESS_SPEC,
  REPLACED_GLOBAL_PROCESS_SPEC,
  REPLACED_PROCESS_ENV_CALLBACK_SPEC,
  SAFE_GLOBAL_REGISTRATION_HELPER_SPEC,
  SHADOWED_ALIAS_GLOBAL_SPEC,
  SHADOWED_BOOLEAN_CONDITION_SPEC,
  SHADOWED_CONSTRUCTOR_GLOBAL_SPEC,
  SHADOWED_FUNCTION_GLOBAL_SPEC,
  SHADOWED_NODE_BUILTIN_ALIAS_SPEC,
  SHADOWED_NODE_BUILTIN_FUNCTION_SPEC,
  SHADOWED_PROCESS_ENV_CALLBACK_SPEC,
  SHADOWED_STRING_RAW_TAG_SPEC,
  SPREAD_DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC,
  SPREAD_REGISTRATION_GETTER_SPEC,
  SPREAD_REGISTRATION_ITERATOR_SPEC,
  STRING_RAW_TAG_SPEC,
  SUITE_MAP_CONSTRUCTOR_SPEC,
  SUPPORTED_PLAYWRIGHT_API_SPEC,
  UI_ALIAS_SPEC,
  UI_SPEC,
  WRAPPED_NODE_BUILTIN_CALLBACK_SPEC,
  conditionalAnnotationSpec,
  indirectConditionalAnnotationSpec,
  wrappedConditionalAnnotationSpec,
};
