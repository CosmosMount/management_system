export function cardToast(
  type: "success" | "error" | "info",
  content: string,
): {
  toast: {
    type: "success" | "error" | "info";
    content: string;
    i18n: { zh_cn: string; en_us: string };
  };
} {
  return {
    toast: {
      type,
      content,
      i18n: {
        zh_cn: content,
        en_us: content,
      },
    },
  };
}
