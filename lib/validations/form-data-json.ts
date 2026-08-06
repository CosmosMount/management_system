export function parseJsonFormField(
  formData: FormData,
  key = "payload",
): unknown {
  const raw = formData.get(key);
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("提交数据不能为空");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("提交数据格式不正确，请刷新页面后重试");
  }
}
