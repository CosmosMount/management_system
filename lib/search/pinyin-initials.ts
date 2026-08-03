const PINYIN_BOUNDARIES = [
  ["a", "阿"],
  ["b", "八"],
  ["c", "嚓"],
  ["d", "哒"],
  ["e", "妸"],
  ["f", "发"],
  ["g", "旮"],
  ["h", "哈"],
  ["j", "讥"],
  ["k", "咔"],
  ["l", "垃"],
  ["m", "妈"],
  ["n", "拿"],
  ["o", "噢"],
  ["p", "妑"],
  ["q", "七"],
  ["r", "呥"],
  ["s", "仨"],
  ["t", "他"],
  ["w", "哇"],
  ["x", "夕"],
  ["y", "丫"],
  ["z", "匝"],
] as const;

const pinyinCollator = new Intl.Collator("zh-Hans-CN-u-co-pinyin");

function pinyinInitial(character: string): string {
  if (/^[a-z0-9]$/iu.test(character)) return character.toLocaleLowerCase();
  if (!/[\u4e00-\u9fff]/u.test(character)) return "";
  for (let index = PINYIN_BOUNDARIES.length - 1; index >= 0; index--) {
    const [letter, boundary] = PINYIN_BOUNDARIES[index];
    if (pinyinCollator.compare(character, boundary) >= 0) return letter;
  }
  return "";
}

export function getPinyinInitials(value: string): string {
  return [...value.normalize("NFKC")].map(pinyinInitial).join("");
}
