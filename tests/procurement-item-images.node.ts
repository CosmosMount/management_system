import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveItemReferenceImagePaths,
  serializeItemReferenceImagePaths,
} from "../lib/purchase-item-images";
import {
  assertItemImagesPresent,
  parseOrderFormData,
  purchaseItemSchema,
} from "../lib/validations/order";
import { MAX_ITEM_REFERENCE_IMAGE_COUNT } from "../lib/upload-accept";

function processingItem(referenceImagePaths: string[] = []) {
  return purchaseItemSchema.parse({
    name: "测试加工件",
    spec: "A-01",
    itemKind: "PROCESSING_FEE",
    purchaseLink: "",
    referenceImagePaths,
    processingVendor: "测试加工商",
    quantity: 1,
    lineTotal: 10,
  });
}

test("采购明细图片集合优先于旧单图字段并保留旧数据回退", () => {
  const paths = ["/uploads/order/front.png", "/uploads/order/back.png"];
  assert.deepEqual(
    resolveItemReferenceImagePaths(
      serializeItemReferenceImagePaths(paths),
      "/uploads/order/legacy.png",
    ),
    paths,
  );
  assert.deepEqual(
    resolveItemReferenceImagePaths("[]", "/uploads/order/legacy.png"),
    ["/uploads/order/legacy.png"],
  );
});

test("订单表单按明细收集多张图片并兼容旧单图键名", () => {
  const formData = new FormData();
  const front = new File(["front"], "front.png", { type: "image/png" });
  const back = new File(["back"], "back.png", { type: "image/png" });
  const legacy = new File(["legacy"], "legacy.png", { type: "image/png" });
  formData.append("itemImage-0-0", front);
  formData.append("itemImage-0-1", back);
  formData.append("itemImage-1", legacy);

  const { itemImages } = parseOrderFormData(formData);
  assert.deepEqual(itemImages.get(0), [front, back]);
  assert.deepEqual(itemImages.get(1), [legacy]);
});

test("加工费图片必填且服务端限制每条明细的图片数量", () => {
  assert.throws(
    () => assertItemImagesPresent([processingItem()], new Map()),
    /上传图片/,
  );

  const files = Array.from(
    { length: MAX_ITEM_REFERENCE_IMAGE_COUNT },
    (_, index) =>
      new File([String(index)], `${index}.png`, { type: "image/png" }),
  );
  assert.doesNotThrow(() =>
    assertItemImagesPresent([processingItem()], new Map([[0, files]])),
  );
  assert.throws(
    () =>
      assertItemImagesPresent(
        [processingItem()],
        new Map([
          [
            0,
            [
              ...files,
              new File(["overflow"], "overflow.png", { type: "image/png" }),
            ],
          ],
        ]),
      ),
    /最多 9 张/,
  );
});

test("采购明细校验拒绝重复的既有图片路径", () => {
  assert.throws(
    () => processingItem(["/uploads/order/same.png", "/uploads/order/same.png"]),
    /参考图片路径重复/,
  );
});
