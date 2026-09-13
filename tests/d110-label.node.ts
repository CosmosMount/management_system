import assert from "node:assert/strict";
import test from "node:test";
import {
  D110_PRINT_DIRECTION,
  D110_QR_MARGIN_MODULES,
  d110BrowserAvailability,
  d110PrintErrorMessage,
  fitD110LabelLines,
  isD110PrinterModel,
  resolveD110PrintTaskName,
  runD110PrintSequence,
} from "../lib/material-management/d110-label";

test("D110 Web Serial requires both a secure context and browser serial support", () => {
  assert.deepEqual(
    d110BrowserAvailability({ isSecureContext: false, hasSerial: true }),
    {
      available: false,
      message: "当前地址不是安全来源，请通过 HTTPS 打开系统后使用 Type-C 打印。",
    },
  );
  assert.deepEqual(
    d110BrowserAvailability({ isSecureContext: true, hasSerial: false }),
    {
      available: false,
      message: "当前浏览器不支持 Web Serial，请使用桌面版 Chrome 或 Edge。",
    },
  );
  assert.equal(
    d110BrowserAvailability({ isSecureContext: true, hasSerial: true }).available,
    true,
  );
});

test("D110 material names are bounded to two printable lines", () => {
  const context = {
    measureText(value: string) {
      return { width: value.length * 10 } as TextMetrics;
    },
  };
  assert.deepEqual(fitD110LabelLines(context, "123456", 25, 2), ["12", "3…"]);
  assert.deepEqual(fitD110LabelLines(context, "", 100, 2), ["未命名物资"]);
});

test("D110 label keeps a four-module QR quiet zone and the 96px printhead direction", () => {
  assert.equal(D110_QR_MARGIN_MODULES, 4);
  assert.equal(D110_PRINT_DIRECTION, "left");
});

test("D110 selection accepts D110_M protocol variants and maps cancellation safely", () => {
  assert.equal(isD110PrinterModel("D110"), true);
  assert.equal(isD110PrinterModel("D110_M"), true);
  assert.equal(isD110PrinterModel(undefined), false);
  assert.equal(resolveD110PrintTaskName("D110", "D110"), "D110");
  assert.equal(resolveD110PrintTaskName("D110_M", "B1"), "B1");
  assert.equal(resolveD110PrintTaskName("D110_M", "D110M_V4"), "D110M_V4");
  assert.equal(resolveD110PrintTaskName("D110_M", "D110"), null);
  assert.equal(resolveD110PrintTaskName("B1", "B1"), null);
  const cancelled = new Error("browser detail must not be exposed");
  cancelled.name = "NotFoundError";
  assert.match(d110PrintErrorMessage(cancelled), /未选择串口设备/);
  assert.doesNotMatch(d110PrintErrorMessage(cancelled), /browser detail/);
});

test("D110 print sequence finishes in protocol order", async () => {
  const calls: string[] = [];
  const image = { id: "label" };
  await runD110PrintSequence(
    {
      async printInit() { calls.push("init"); },
      async printPage(value, quantity) {
        assert.equal(value, image);
        assert.equal(quantity, 1);
        calls.push("page");
      },
      async waitForFinished() { calls.push("wait"); },
      async printEnd() { calls.push("end"); return true; },
    },
    image,
  );
  assert.deepEqual(calls, ["init", "page", "wait", "end"]);
});

test("D110 print sequence reports end refusal without hiding an earlier failure", async () => {
  await assert.rejects(
    runD110PrintSequence(
      {
        async printInit() {},
        async printPage() {},
        async waitForFinished() {},
        async printEnd() { return false; },
      },
      {},
    ),
    /PRINT_END_REJECTED/,
  );

  const original = new Error("page failed");
  await assert.rejects(
    runD110PrintSequence(
      {
        async printInit() {},
        async printPage() { throw original; },
        async waitForFinished() {},
        async printEnd() { throw new Error("end failed"); },
      },
      {},
    ),
    (error) => error === original,
  );
});
