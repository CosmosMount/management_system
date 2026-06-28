import { expect, test } from "@playwright/test";
import * as XLSX from "xlsx";
import {
  buildProgressTaskImportTemplateWorkbook,
  parseProgressTasksFromWorkbook,
} from "../lib/import-progress-tasks";

const users = [
  { openId: "ou_liqixuan", name: "李棋轩" },
  { openId: "ou_lichaokai", name: "李朝凯" },
];

test("验收标准 XLSX/CSV 可解析为任务预览", () => {
  const xlsxResult = parseProgressTasksFromWorkbook(
    buildProgressTaskImportTemplateWorkbook(),
    users,
  );
  expect(xlsxResult.errors).toEqual([]);
  expect(xlsxResult.tasks).toHaveLength(2);
  expect(xlsxResult.tasks[0]).toMatchObject({
    title: "裁判系统安装--装甲板安装",
    taskTechGroups: ["机械"],
    assigneeOpenIds: ["ou_liqixuan"],
    metrics: "根据规则手册完成安装并通过检查",
    needsWeeklyReport: false,
    urgency: "LOW",
    importance: "HIGH",
  });
  expect(xlsxResult.tasks[0]?.goal).toContain("分类：规则相关");
  expect(xlsxResult.tasks[0]?.goal).toContain("备注：可按实际验收口径补充");

  const csv = [
    "测试/验收内容,负责组别,负责人,参考/要求,是否需要定期周报,分类,备注,紧急程度,重要程度,最晚完成时间",
    '"机械臂重复存取矿测试","机械, 电控","李棋轩,李朝凯","连续25组稳定成功",是,"功能测试, 压力测试",无,高,高,2026/06/29',
  ].join("\n");
  const csvWorkbook = XLSX.read(csv, { type: "string" });
  const csvResult = parseProgressTasksFromWorkbook(csvWorkbook, users);

  expect(csvResult.errors).toEqual([]);
  expect(csvResult.tasks).toHaveLength(1);
  expect(csvResult.tasks[0]).toMatchObject({
    taskTechGroups: ["机械", "电控"],
    assigneeOpenIds: ["ou_liqixuan", "ou_lichaokai"],
    needsWeeklyReport: true,
    urgency: "HIGH",
    importance: "HIGH",
  });
});

test("验收标准导入会保留行级警报且结构错误阻断", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      [
        "测试/验收内容",
        "负责组别",
        "负责人",
        "参考/要求",
        "紧急程度",
        "重要程度",
        "最晚完成时间",
      ],
      ["未知任务", "不存在组", "不存在的人", "指标", "非常急", "很重要", "not-a-date"],
      ["缺 DDL 任务", "通用", "李棋轩", "指标", "中", "中", ""],
      ["短日期任务", "通用", "李棋轩", "指标", "中", "中", "6/29/26"],
      ["使用方式：说明行", "", "", "", "", "", ""],
    ]),
    "数据表",
  );

  const result = parseProgressTasksFromWorkbook(workbook, users);
  expect(result.errors).toEqual([]);
  expect(result.tasks).toHaveLength(3);
  expect(result.tasks[0]?.warnings.map((warning) => warning.message).join("\n")).toContain(
    "无法识别技术组",
  );
  expect(result.tasks[0]?.warnings.map((warning) => warning.message).join("\n")).toContain(
    "未找到负责人",
  );
  expect(result.tasks[0]?.warnings.map((warning) => warning.message).join("\n")).toContain(
    "无法识别最晚完成时间",
  );
  expect(result.tasks[0]?.warnings.map((warning) => warning.message).join("\n")).toContain(
    "无法识别“非常急”",
  );
  expect(result.tasks[0]?.taskTechGroups).toEqual(["通用"]);
  expect(result.tasks[1]?.warnings.map((warning) => warning.message).join("\n")).toContain(
    "缺少最晚完成时间",
  );
  expect(result.tasks[1]?.dueAt).toBe("");
  expect(result.tasks[2]?.warnings).toHaveLength(0);
  expect(result.tasks[2]?.dueAt).toMatch(/^2026-06-29T18:00/);

  const badWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    badWorkbook,
    XLSX.utils.aoa_to_sheet([["无关列"], ["内容"]]),
    "数据表",
  );
  const badResult = parseProgressTasksFromWorkbook(badWorkbook, users);
  expect(badResult.tasks).toEqual([]);
  expect(badResult.errors[0]?.message).toContain("缺少必填列");
});
