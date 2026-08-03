import { expect, test } from "@playwright/test";
import {
  fuzzyScore,
  rankFuzzyMatches,
} from "../lib/search/fuzzy-score";
import {
  compactSearchText,
  normalizeSearchText,
  searchTerms,
} from "../lib/search/normalize-search-text";

test.describe("shared fuzzy search", () => {
  test("normalizes NFKC, case and whitespace while retaining AND terms", () => {
    expect(normalizeSearchText("  ＡＢＣ\t 视觉  标定  ")).toBe("abc 视觉 标定");
    expect(compactSearchText("  ＡＢＣ\t 视觉  ")).toBe("abc视觉");
    expect(searchTerms("  视觉   标定 ")).toEqual(["视觉", "标定"]);
  });

  test("matches Chinese substring, pinyin initials and ordered subsequences", () => {
    expect(fuzzyScore([{ text: "张三", pinyin: true }], "张")).not.toBeNull();
    expect(fuzzyScore([{ text: "张三", pinyin: true }], "zs")).not.toBeNull();
    expect(fuzzyScore([{ text: "张思远", pinyin: true }], "zsy")).not.toBeNull();
    expect(fuzzyScore([{ text: "视觉目标标定" }], "视标")).not.toBeNull();
  });

  test("uses AND semantics across fields and rejects a missing term", () => {
    const fields = [
      { text: "视觉算法" },
      { text: "完成相机标定" },
    ];
    expect(fuzzyScore(fields, "视觉 标定")).not.toBeNull();
    expect(fuzzyScore(fields, "视觉 雷达")).toBeNull();
  });

  test("keeps tier ordering and stable explicit tie breaks", () => {
    const rows = [
      { id: "b", title: "视觉标定" },
      { id: "a", title: "视觉标定" },
      { id: "c", title: "前置视觉标定" },
    ];
    const ranked = rankFuzzyMatches(
      rows,
      "视觉",
      (row) => [{ text: row.title }],
      (left, right) => left.id.localeCompare(right.id),
    );
    expect(ranked.map(({ item }) => item.id)).toEqual(["a", "b", "c"]);
  });
});
